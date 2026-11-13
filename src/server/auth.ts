// Single-owner authentication.
//
//  - Password: scrypt hash in the meta table, or OPENWHOOP_PASSWORD from the
//    environment (hashed in memory at boot).
//  - Browser sessions: random token in an HttpOnly cookie; only its SHA-256
//    is stored. 30-day sliding expiry.
//  - API tokens: "owk_…" bearer tokens for integrations and scripts, stored
//    hashed, scoped read or write.
//  - When no password exists, the instance is open only if it listens on
//    loopback; otherwise first-run setup needs the one-time token printed to
//    the server log.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { all, get, getMeta, now, run, setMeta, type Db } from "./db.ts";
import type { Config } from "./config.ts";

const COOKIE = "ow_session";
const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const got = scryptSync(pw, Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(got, Buffer.from(hash, "hex"));
}

export interface AuthState {
  passwordHash: string | null;
  setupToken: string | null;
}

export function initAuth(db: Db, cfg: Config): AuthState {
  let passwordHash = getMeta<string | null>(db, "password_hash", null);
  if (cfg.password) passwordHash = hashPassword(cfg.password);
  const setupToken = !passwordHash && !cfg.loopback && cfg.auth !== "off" ? randomBytes(12).toString("base64url") : null;
  return { passwordHash, setupToken };
}

export type AuthMode = "open" | "setup" | "locked";
export function authMode(state: AuthState, cfg: Config): AuthMode {
  if (cfg.auth === "off") return "open";
  if (state.passwordHash) return "locked";
  return cfg.loopback ? "open" : "setup";
}

// ── rate limiting (per IP, in memory) ─────────────────────────────────
const attempts = new Map<string, { n: number; until: number }>();
export function rateLimited(ip: string): boolean {
  const a = attempts.get(ip);
  return !!a && a.n >= 10 && a.until > Date.now();
}
export function recordFailure(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}

// ── sessions ──────────────────────────────────────────────────────────

export function createSession(db: Db, c: Context, secure: boolean) {
  const token = randomBytes(32).toString("base64url");
  run(db, "INSERT INTO sessions (id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)", sha256(token), now(), now() + SESSION_DAYS * 86400, (c.req.header("user-agent") ?? "").slice(0, 200));
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: SESSION_DAYS * 86400 });
}

export function destroySession(db: Db, c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) run(db, "DELETE FROM sessions WHERE id = ?", sha256(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

function sessionValid(db: Db, token: string | undefined): boolean {
  if (!token) return false;
  const s = get<{ expires_at: number }>(db, "SELECT expires_at FROM sessions WHERE id = ?", sha256(token));
  if (!s || s.expires_at < now()) return false;
  if (s.expires_at - now() < (SESSION_DAYS - 1) * 86400) run(db, "UPDATE sessions SET expires_at = ? WHERE id = ?", now() + SESSION_DAYS * 86400, sha256(token));
  return true;
}

export function revokeAllSessions(db: Db) {
  run(db, "DELETE FROM sessions");
}

// ── API tokens ────────────────────────────────────────────────────────

export function createToken(db: Db, name: string, scope: "read" | "write") {
  const token = `owk_${randomBytes(24).toString("base64url")}`;
  run(db, "INSERT INTO api_tokens (name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?)", name, sha256(token), token.slice(0, 8), scope, now());
  return token;
}

export function listTokens(db: Db) {
  return all<{ id: number; name: string; prefix: string; scope: string; created_at: number; last_used_at: number | null }>(db, "SELECT id, name, prefix, scope, created_at, last_used_at FROM api_tokens ORDER BY id");
}

function tokenScope(db: Db, header: string | undefined): "read" | "write" | null {
  const m = /^Bearer (owk_[A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return null;
  const t = get<{ id: number; scope: "read" | "write" }>(db, "SELECT id, scope FROM api_tokens WHERE token_hash = ?", sha256(m[1]!));
  if (!t) return null;
  run(db, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now(), t.id);
  return t.scope;
}

// ── middleware ────────────────────────────────────────────────────────

export type Principal = "owner" | "token:read" | "token:write";

/**
 * Guards /api/*. Cookie sessions get full access but mutating requests must
 * come from our own origin (CSRF). Bearer tokens get read, or read+write, and
 * can never manage auth, tokens or webhooks.
 */
export function requireAuth(db: Db, state: AuthState, cfg: Config): MiddlewareHandler<{ Variables: { principal: Principal } }> {
  return async (c, next) => {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const scope = tokenScope(db, c.req.header("authorization"));
    if (scope) {
      const path = c.req.path;
      const forbidden = /^\/api\/(auth|tokens|webhooks|integrations\/[^/]+\/(config|connect|callback))/.test(path);
      if (forbidden || (mutating && scope !== "write")) return c.json({ error: "token not allowed here" }, 403);
      c.set("principal", scope === "write" ? "token:write" : "token:read");
      return next();
    }
    const mode = authMode(state, cfg);
    if (mode === "setup") return c.json({ error: "setup required" }, 401);
    if (mode === "locked" && !sessionValid(db, getCookie(c, COOKIE))) return c.json({ error: "unauthorized" }, 401);
    if (mutating) {
      const origin = c.req.header("origin");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if (origin && host && new URL(origin).host !== host) return c.json({ error: "cross-origin request blocked" }, 403);
    }
    c.set("principal", "owner");
    return next();
  };
}

export function savePassword(db: Db, state: AuthState, pw: string) {
  state.passwordHash = hashPassword(pw);
  state.setupToken = null;
  setMeta(db, "password_hash", state.passwordHash);
}
