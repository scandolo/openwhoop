# Integrations, API and webhooks

OpenWhoop is open in three ways:
1. **API tokens:** read (or read and write) everything the app shows.
2. **Webhooks:** get pushed an event when something is scored.
3. **Built-in integrations:** small modules with their own setup (WHOOP, Strava).

## API tokens

To create a token, go to **Settings → API tokens**. Tokens look like `owk_…`
and are shown once.

```bash
curl -H "Authorization: Bearer owk_…" https://your-instance/api/overview
curl -H "Authorization: Bearer owk_…" "https://your-instance/api/trends?days=90"
```

- **Read tokens** can call any `GET` endpoint.
- **Read+write tokens** can also log journal answers and workouts, and upload
  strap data. That lets a separate device, such as a Raspberry Pi bridge, sync
  for you.
- **No token** can manage tokens, webhooks, integration credentials or the
  password.

| Endpoint | What |
|---|---|
| `GET /api/overview?date=YYYY-MM-DD` | The day: recovery, sleep, strain, stress, workouts, tonight's plan (omit `date` for today) |
| `GET /api/sleep?date=` | Sleep detail with stages and heart rate |
| `GET /api/day?date=` | Per-minute heart rate, stress and state for a cycle |
| `GET /api/trends?days=30` | One row per cycle: recovery, HRV, RHR, resp, strain, sleep metrics |
| `GET /api/workouts` · `POST /api/workouts` | List, or add `{start, end, sport, name}` (unix seconds) |
| `GET /api/journal?date=` · `PUT /api/journal` | Journal questions and answers `{date, answers: {alcohol: true}}` |
| `GET /api/insights` | What affects your recovery |
| `GET /api/events` | Event log |
| `GET /api/export/cycles.csv` | All cycles in WHOOP's `physiological_cycles.csv` format |
| `POST /api/ingest` | Upload raw strap frames `{device, frames: [base64…]}` (write scope) |

## Webhooks

To add one, go to **Settings → Webhooks**: give a URL and pick the events.
OpenWhoop POSTs JSON:

```json
{ "type": "recovery.scored", "ts": 1763030400, "data": { "date": "2026-11-13", "recovery": 74, "band": "green", "hrv": 68.2, "rhr": 52.1, "sleepPerformance": 88 } }
```

| Event | When |
|---|---|
| `sync.completed` | a strap sync finished |
| `sleep.scored` | a new night was scored |
| `recovery.scored` | the morning's recovery is ready |
| `workout.created` | a workout was detected, logged or imported |
| `stress.high` | stress stayed ≥ 2.0 for 10+ minutes |
| `journal.updated` | journal answers saved |
| `alarm.fired` | the smart alarm woke you |

Failed deliveries are retried twice, 5 s and then 25 s later. Every request is
signed:

```
X-OpenWhoop-Event: recovery.scored
X-OpenWhoop-Timestamp: 1763030400
X-OpenWhoop-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with your secret>
```

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
```

Some ideas:
- Turn the lights green in Home Assistant on a green recovery.
- Post your morning score to a Slack channel.
- Log workouts to a spreadsheet through n8n.

## WHOOP (official API): companion mode

To keep using the official WHOOP app alongside OpenWhoop:

1. Keep **companion mode** on (Strap page). OpenWhoop then reads the strap
   without telling it to free its memory, so the WHOOP app still receives
   everything.
2. Create an app at https://developer-dashboard.whoop.com:
   - Redirect URL: `https://your-instance/api/integrations/whoop/callback`. For
     local use, `http://localhost:8787/api/integrations/whoop/callback`.
   - Scopes: all `read:*`, plus `offline`.
3. Paste the client ID and secret into **Settings → Integrations → WHOOP**, then
   press **Connect**.

What it does:
- Imports WHOOP's cycles, recoveries, sleeps and workouts every 30 minutes.
- Shows WHOOP's number under each dial.
- Reports agreement (mean error and correlation) between OpenWhoop and WHOOP.
- Adopts WHOOP's measured max HR, weight, height and sleep-need baseline,
  unless you set your own.
- After 14 nights scored by both, fits a personal recovery calibration
  ([algorithms.md](algorithms.md#recovery)).

A caveat on companion mode: some firmware re-sends a batch it was never told it
could free. In that case a sync stops early and says so. Let the WHOOP app sync
first, or turn companion mode off. With it off, OpenWhoop frees the strap's
memory after each batch is saved, so the WHOOP app won't see that data.

## Strava

1. Create an API application at https://www.strava.com/settings/api. Set
   **Authorization Callback Domain** to your instance's host (`localhost` works
   locally).
2. Paste the client ID and secret into **Settings → Integrations → Strava** and
   press **Connect**.

Activities are imported and become your workouts. Strain, zones and calories
are computed from your strap data for the activity's time window, and they
replace the anonymous auto-detected entry. With **Add strain to Strava
descriptions** on, OpenWhoop appends a line like
`Strain 13.2 · avg HR 151 · Recovery 74% — OpenWhoop` to each activity, once.

## Writing an integration

An integration is one file in `src/server/integrations/` implementing
`Integration` (`store.ts`):

```ts
export const myThing: Integration = {
  id: "mything",
  name: "My Thing",
  description: "One line for Settings.",
  fields: [{ key: "apiKey", label: "API key", secret: true }],
  status: (ctx) => ({ connected: !!integrationRow(ctx.db, "mything").config.apiKey }),
  async onEvent(ctx, e) { if (e.type === "recovery.scored") await fetch(/* … */); },
  async sync(ctx) { return "pulled 3 things"; }, // every 30 min and on "Sync now"
  routes(app, ctx) { /* OAuth callbacks under /api/integrations/mything/… */ },
};
```

Add it to `INTEGRATIONS` in `index.ts`. Settings renders its fields
automatically. Secrets are write-only in the UI and stored in the instance's
SQLite database.
