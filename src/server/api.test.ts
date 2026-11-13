import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { buildApi } from "./api.ts";
import { initAuth } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDb, run } from "./db.ts";
import { createWebhook, deliver, listWebhooks } from "./integrations/webhooks.ts";
import { agreement, fitPersonalOffset, MIN_PAIRED_NIGHTS, whoopFor } from "./integrations/whoop.ts";
import { logit, sigmoid } from "../algorithms/stats.ts";

function setup(over: Partial<Config> = {}) {
  const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: "", dbPath: ":memory:", password: null, auth: "auto", loopback: true, publicUrl: null, rawRetentionDays: 30, webDir: "", ...over };
  const db = openDb(":memory:");
  const auth = initAuth(db, cfg);
  const { app } = buildApi(db, cfg, auth);
  const req = async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> =>
    app.request(path, { ...init, headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  return { db, auth, app, req };
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

describe("auth", () => {
  it("is open on loopback until a password exists", async () => {
    const { req } = setup();
    expect((await req("/api/auth/state").then((r) => r.json())).mode).toBe("open");
    expect((await req("/api/settings")).status).toBe(200);
  });

  it("requires the one-time token to set up a hosted instance", async () => {
    const { req, auth } = setup({ host: "0.0.0.0", loopback: false });
    expect((await req("/api/settings")).status).toBe(401);
    expect((await req("/api/auth/setup", { method: "POST", json: { password: "correct horse", token: "nope" } })).status).toBe(403);
    const ok = await req("/api/auth/setup", { method: "POST", json: { password: "correct horse", token: auth.setupToken } });
    expect(ok.status).toBe(200);
    const cookie = cookieOf(ok);
    expect((await req("/api/settings", { headers: { cookie } })).status).toBe(200);
    expect((await req("/api/settings")).status).toBe(401);
    // a second setup is refused
    expect((await req("/api/auth/setup", { method: "POST", json: { password: "another one", token: auth.setupToken ?? "" } })).status).toBe(409);
  });

  it("logs in, rate-limits guessing, and blocks cross-origin writes", async () => {
    const { req } = setup({ password: "s3cret-pass", loopback: false, host: "0.0.0.0" });
    expect((await req("/api/auth/login", { method: "POST", json: { password: "wrong" } })).status).toBe(401);
    const ok = await req("/api/auth/login", { method: "POST", json: { password: "s3cret-pass" } });
    const cookie = cookieOf(ok);
    const put = (origin: string) => req("/api/journal", { method: "PUT", headers: { cookie, origin, host: "me.example" }, json: { date: "2026-11-12", answers: { alcohol: true } } });
    expect((await put("https://evil.example")).status).toBe(403);
    expect((await put("https://me.example")).status).toBe(200);
    for (let i = 0; i < 10; i++) await req("/api/auth/login", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, json: { password: "x" } });
    expect((await req("/api/auth/login", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, json: { password: "s3cret-pass" } })).status).toBe(429);
  });

  it("scopes API tokens", async () => {
    const { req } = setup();
    const read = (await req("/api/tokens", { method: "POST", json: { name: "dash", scope: "read" } }).then((r) => r.json())).token as string;
    const write = (await req("/api/tokens", { method: "POST", json: { name: "bot", scope: "write" } }).then((r) => r.json())).token as string;
    const as = (t: string) => ({ authorization: `Bearer ${t}` });
    expect((await req("/api/overview", { headers: as(read) })).status).toBe(200);
    expect((await req("/api/journal", { method: "PUT", headers: as(read), json: { date: "2026-11-12", answers: {} } })).status).toBe(403);
    expect((await req("/api/journal", { method: "PUT", headers: as(write), json: { date: "2026-11-12", answers: {} } })).status).toBe(200);
    expect((await req("/api/tokens", { headers: as(write) })).status).toBe(403);
    expect((await req("/api/webhooks", { headers: as(write) })).status).toBe(403);
  });

  it("rejects malformed input", async () => {
    const { req } = setup();
    expect((await req("/api/workouts", { method: "POST", json: { start: 10, end: 5, sport: "run" } })).status).toBe(400);
    expect((await req("/api/settings/profile", { method: "PUT", json: { weightKg: 5 } })).status).toBe(400);
  });
});

describe("webhooks", () => {
  it("delivers signed events", async () => {
    const { db } = setup();
    let delivery: Promise<number | null> = Promise.resolve(null);
    const got = await new Promise<{ sig: string; ts: string; body: string; event: string }>((resolve) => {
      const srv = createServer((rq, rs) => {
        let body = "";
        rq.on("data", (d) => (body += d));
        rq.on("end", () => {
          rs.end("ok");
          srv.close();
          resolve({ sig: String(rq.headers["x-openwhoop-signature"]), ts: String(rq.headers["x-openwhoop-timestamp"]), body, event: String(rq.headers["x-openwhoop-event"]) });
        });
      }).listen(0, "127.0.0.1", () => {
        const port = (srv.address() as { port: number }).port;
        const hook = createWebhook(db, `http://127.0.0.1:${port}/hook`, ["recovery.scored"]);
        delivery = deliver(db, hook, { type: "recovery.scored", ts: 1, data: { recovery: 81 } });
      });
    });
    expect(await delivery).toBe(200);
    const secret = listWebhooks(db)[0]!.secret;
    expect(got.event).toBe("recovery.scored");
    expect(JSON.parse(got.body).data.recovery).toBe(81);
    expect(got.sig).toBe("sha256=" + createHmac("sha256", secret).update(`${got.ts}.${got.body}`).digest("hex"));
    expect(listWebhooks(db)[0]!.last_status).toBe(200);
  });
});

describe("WHOOP companion integration", () => {
  it("pairs cycles and learns a personal recovery offset", () => {
    const { db } = setup();
    const t0 = Date.parse("2026-09-01T22:30:00Z") / 1000;
    const trueOffset = 0.5; // WHOOP sits consistently above our raw model for this person
    for (let i = 0; i < MIN_PAIRED_NIGHTS + 6; i++) {
      const start = t0 + i * 86400;
      const raw = 30 + ((i * 37) % 60);
      const whoopScore = Math.round(100 * sigmoid(logit(raw / 100) + trueOffset));
      run(db, "INSERT INTO cycles (start, end, sleep_id, date, recovery, strain, sleep_score, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, 0)", start, start + 86400, `d${i}`, JSON.stringify({ score: raw, raw }), JSON.stringify({ strain: 10 }), JSON.stringify({ performance: 80 }));
      run(db, "INSERT INTO whoop_reference (kind, id, start, end, data) VALUES ('cycle', ?, ?, ?, ?)", String(i), start + 1200, start + 86400, JSON.stringify({ id: i, start: "", end: null, score_state: "SCORED", score: { strain: 11, kilojoule: 9000, average_heart_rate: 70, max_heart_rate: 160 } }));
      run(db, "INSERT INTO whoop_reference (kind, id, start, end, data) VALUES ('recovery', ?, ?, NULL, ?)", String(i), start + 1200, JSON.stringify({ cycle_id: i, sleep_id: "x", score_state: "SCORED", score: { user_calibrating: false, recovery_score: whoopScore, resting_heart_rate: 55, hrv_rmssd_milli: 60 } }));
    }
    expect(whoopFor(db, t0 + 300)!.recovery).toBeGreaterThan(30);
    expect(whoopFor(db, t0 - 5 * 3600)).toBeNull();
    const cal = fitPersonalOffset(db)!;
    expect(cal.offset).toBeCloseTo(trueOffset, 1);
    const a = agreement(db);
    expect(a.recovery.n).toBe(MIN_PAIRED_NIGHTS + 6);
    expect(a.strain.mae).toBe(1);
  });
});
