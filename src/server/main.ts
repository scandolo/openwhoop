// OpenWhoop server: API + the built web app, from one process.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { authMode, initAuth } from "./auth.ts";
import { buildApi } from "./api.ts";
import { onEvent } from "./events.ts";
import { webhookListener } from "./integrations/webhooks.ts";
import { INTEGRATIONS, integrationRow, runIntegration } from "./integrations/index.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const auth = initAuth(db, cfg);
const { app: api, ctx } = buildApi(db, cfg, auth);

onEvent(webhookListener(db));
for (const i of INTEGRATIONS) if (i.onEvent) onEvent((e) => (integrationRow(db, i.id).enabled ? i.onEvent!(ctx, e) : undefined));
setInterval(() => {
  for (const i of INTEGRATIONS) void runIntegration(ctx, i).catch(() => {});
}, 30 * 60_000).unref();

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json" };

const app = new Hono();
app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
  c.header("x-frame-options", "DENY");
  c.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  c.header("permissions-policy", "bluetooth=(self), screen-wake-lock=(self)");
});
app.route("/", api);
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
  const rel = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "");
  let file = join(cfg.webDir, rel);
  if (!file.startsWith(cfg.webDir) || !existsSync(file) || !extname(file)) file = join(cfg.webDir, "index.html");
  if (!existsSync(file)) return c.text("Web app not built. Run `npm run build`, or `npm run dev` for development.", 503);
  const body = await readFile(file);
  const immutable = file.includes(`${join(cfg.webDir, "assets")}`);
  return c.body(body, 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
});

serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  const url = `http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${info.port}`;
  console.log(`OpenWhoop listening on ${url}  (data: ${cfg.dataDir})`);
  const mode = authMode(auth, cfg);
  if (mode === "open") console.log(cfg.auth === "off" ? "Auth is OFF (OPENWHOOP_AUTH=off)." : "No password set — open on loopback only. Set one in Settings to lock it.");
  if (mode === "setup") console.log(`First run: create your password at ${cfg.publicUrl ?? url}/setup?token=${auth.setupToken}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
  db.close();
  process.exit(0);
});
