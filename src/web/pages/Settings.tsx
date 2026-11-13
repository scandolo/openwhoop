import { useEffect, useState, type ReactNode } from "react";
import { api, dataChanged, useApi } from "../api.ts";
import { Card, ErrorNote, Loading, Row, Switch } from "../components/ui.tsx";
import { ago } from "../format.ts";

interface SettingsData {
  profile: { name: string; birthYear: number | null; sex: "male" | "female"; weightKg: number; heightCm: number; maxHrOverride: number | null; sleepNeedBaselineMin: number | null; timezone: string; units: string };
  alarm: { enabled: boolean; mode: "exact" | "sleep_goal" | "in_the_green"; latestWake: string; windowMin: number; goalPct: 70 | 85 | 100 };
  haptics: { stressNudges: boolean; stressThreshold: number; stressMinutes: number; strainTargetBuzz: boolean; bedtimeNudge: boolean; quietStart: string; quietEnd: string };
  questions: { id: string; label: string; enabled: boolean }[];
  physiology: { restingHr: number; maxHr: number };
}

function useSection<T>(initial: T | undefined, section: string) {
  const [v, setV] = useState<T | undefined>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  useEffect(() => setV(initial), [initial]);
  const save = async (next?: T) => {
    setState("saving");
    try {
      await api(`/api/settings/${section}`, { method: "PUT", json: next ?? v });
      setState("saved");
      dataChanged();
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  };
  return { v, setV, save, state };
}

const Saved = ({ state }: { state: string }) => <span className="tiny">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "idle" ? "" : <span className="error">{state}</span>}</span>;

export function Settings() {
  const s = useApi<SettingsData>("/api/settings");
  if (s.error) return <ErrorNote error={s.error} retry={s.reload} />;
  if (!s.data) return <Loading />;
  return (
    <>
      <header className="topbar">
        <h1 className="page-title" style={{ margin: 0 }}>Settings</h1>
      </header>
      <div className="grid2">
        <div className="stack">
          <Profile initial={s.data.profile} physiology={s.data.physiology} />
          <Alarm initial={s.data.alarm} />
          <Haptics initial={s.data.haptics} />
          <Questions initial={s.data.questions} />
        </div>
        <div className="stack">
          <Integrations />
          <Webhooks />
          <Tokens />
          <Account />
          <Card title="Data">
            <div className="stack">
              <a className="btn ghost small" href="/api/export/cycles.csv" download>Export cycles (WHOOP CSV format)</a>
              <p className="tiny">OpenWhoop is an independent open-source project, not affiliated with or endorsed by WHOOP, Inc. Scores are estimates for personal insight, not medical advice.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Profile({ initial, physiology }: { initial: SettingsData["profile"]; physiology: SettingsData["physiology"] }) {
  const { v, setV, save, state } = useSection(initial, "profile");
  if (!v) return null;
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [v.timezone];
  const num = (x: string) => (x === "" ? null : Number(x));
  return (
    <Card title="Profile" action={<Saved state={state} />}>
      <div className="form-grid">
        <Field label="Name"><input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Birth year"><input className="input" inputMode="numeric" value={v.birthYear ?? ""} onChange={(e) => setV({ ...v, birthYear: num(e.target.value) })} /></Field>
        <Field label="Sex (for calories)">
          <select className="input" value={v.sex} onChange={(e) => setV({ ...v, sex: e.target.value as "male" | "female" })}>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </Field>
        <Field label="Weight (kg)"><input className="input" inputMode="decimal" value={v.weightKg} onChange={(e) => setV({ ...v, weightKg: Number(e.target.value) })} /></Field>
        <Field label="Height (cm)"><input className="input" inputMode="numeric" value={v.heightCm} onChange={(e) => setV({ ...v, heightCm: Number(e.target.value) })} /></Field>
        <Field label={`Max HR (est. ${physiology.maxHr})`}><input className="input" inputMode="numeric" placeholder="auto" value={v.maxHrOverride ?? ""} onChange={(e) => setV({ ...v, maxHrOverride: num(e.target.value) })} /></Field>
        <Field label="Baseline sleep need (h)"><input className="input" inputMode="decimal" placeholder="auto (≈8.0)" value={v.sleepNeedBaselineMin ? (v.sleepNeedBaselineMin / 60).toFixed(2) : ""} onChange={(e) => setV({ ...v, sleepNeedBaselineMin: e.target.value ? Math.round(Number(e.target.value) * 60) : null })} /></Field>
        <Field label="Time zone">
          <select className="input" value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>
            {zones.map((z) => <option key={z}>{z}</option>)}
          </select>
        </Field>
      </div>
      <div className="hstack between" style={{ marginTop: 12 }}>
        <span className="tiny">Resting HR {Math.round(physiology.restingHr)} bpm, from your recent nights.</span>
        <button className="btn small" onClick={() => void save()}>Save</button>
      </div>
    </Card>
  );
}

function Alarm({ initial }: { initial: SettingsData["alarm"] }) {
  const { v, setV, save, state } = useSection(initial, "alarm");
  if (!v) return null;
  return (
    <Card title="Smart alarm" action={<Saved state={state} />}>
      <div className="hstack between" style={{ marginBottom: 12 }}>
        <span>Wake me with the strap</span>
        <Switch label="Alarm" checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} />
      </div>
      <div className="form-grid">
        <Field label="Mode">
          <select className="input" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value as SettingsData["alarm"]["mode"] })}>
            <option value="exact">Exact time</option>
            <option value="sleep_goal">Sleep goal</option>
            <option value="in_the_green">In the green</option>
          </select>
        </Field>
        <Field label="Latest wake time"><input className="input" type="time" value={v.latestWake} onChange={(e) => setV({ ...v, latestWake: e.target.value })} /></Field>
        {v.mode !== "exact" && (
          <Field label="Window (min)">
            <select className="input" value={v.windowMin} onChange={(e) => setV({ ...v, windowMin: Number(e.target.value) })}>
              {[15, 30, 45, 60].map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
        )}
        {v.mode === "sleep_goal" && (
          <Field label="Goal">
            <select className="input" value={v.goalPct} onChange={(e) => setV({ ...v, goalPct: Number(e.target.value) as 70 | 85 | 100 })}>
              <option value={100}>Peak (100%)</option>
              <option value={85}>Perform (85%)</option>
              <option value={70}>Get by (70%)</option>
            </select>
          </Field>
        )}
      </div>
      <div className="hstack between" style={{ marginTop: 12 }}>
        <span className="tiny">Smart modes need Night mode running on a connected device. The strap's own alarm is always set to the latest time as a backup.</span>
        <button className="btn small" onClick={() => void save()}>Save</button>
      </div>
    </Card>
  );
}

function Haptics({ initial }: { initial: SettingsData["haptics"] }) {
  const { v, setV, save, state } = useSection(initial, "haptics");
  if (!v) return null;
  const toggle = (key: "stressNudges" | "strainTargetBuzz" | "bedtimeNudge", label: string, sub: string) => (
    <Row title={label} sub={sub} right={<Switch label={label} checked={v[key]} onChange={(x) => { const n = { ...v, [key]: x }; setV(n); void save(n); }} />} />
  );
  return (
    <section className="card flush" id="haptics">
      <div className="card-head" style={{ padding: "16px 16px 0" }}><h2>Haptic automations</h2><Saved state={state} /></div>
      <div className="rows">
        {toggle("stressNudges", "Stress nudges", "Buzz when stress stays high for 10+ minutes")}
        {toggle("strainTargetBuzz", "Strain target", "Two taps when you reach today's optimal strain")}
        {toggle("bedtimeNudge", "Bedtime nudge", "A buzz when it's time to wind down")}
        <div className="row">
          <div className="grow">Quiet hours<div className="sub">No nudges between</div></div>
          <input className="input" type="time" style={{ width: 110 }} value={v.quietStart} onChange={(e) => setV({ ...v, quietStart: e.target.value })} onBlur={() => void save()} />
          <input className="input" type="time" style={{ width: 110 }} value={v.quietEnd} onChange={(e) => setV({ ...v, quietEnd: e.target.value })} onBlur={() => void save()} />
        </div>
      </div>
    </section>
  );
}

function Questions({ initial }: { initial: SettingsData["questions"] }) {
  const { v, setV, save, state } = useSection(initial, "questions");
  const [label, setLabel] = useState("");
  if (!v) return null;
  const add = () => {
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    if (!id || v.some((q) => q.id === id)) return;
    const n = [...v, { id, label: label.trim(), enabled: true }];
    setV(n);
    setLabel("");
    void save(n);
  };
  return (
    <section className="card flush">
      <div className="card-head" style={{ padding: "16px 16px 0" }}><h2>Journal questions</h2><Saved state={state} /></div>
      <div className="rows">
        {v.map((q, i) => (
          <Row key={q.id} title={q.label} right={<Switch label={q.label} checked={q.enabled} onChange={(x) => { const n = v.map((y, j) => (j === i ? { ...y, enabled: x } : y)); setV(n); void save(n); }} />} />
        ))}
        <div className="row">
          <input className="input" placeholder="Add a question, e.g. Took magnesium?" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="btn small" onClick={add} disabled={!label.trim()}>Add</button>
        </div>
      </div>
    </section>
  );
}

interface IntegrationInfo {
  id: string;
  name: string;
  description: string;
  fields: { key: string; label: string; secret?: boolean; type?: "text" | "boolean"; help?: string }[];
  enabled: boolean;
  config: Record<string, string | boolean>;
  connected: boolean;
  account?: string;
  lastRunAt: number | null;
  lastError: string | null;
}

function Integrations() {
  const r = useApi<IntegrationInfo[]>("/api/integrations");
  return (
    <Card title="Integrations">
      <div className="stack">
        {r.data?.map((i) => <IntegrationCard key={i.id} i={i} reload={r.reload} />)}
        <p className="tiny">Anything else (Zapier, n8n, Home Assistant, your own scripts) can use webhooks and API tokens below. New built-in integrations are a small module in <code>src/server/integrations/</code>.</p>
      </div>
    </Card>
  );
}

function IntegrationCard({ i, reload }: { i: IntegrationInfo; reload: () => void }) {
  const [cfg, setCfg] = useState(i.config);
  const [msg, setMsg] = useState<string | null>(null);
  const saveCfg = async () => {
    await api(`/api/integrations/${i.id}/config`, { method: "PUT", json: { config: cfg } });
    setMsg("Saved");
    reload();
  };
  const sync = async () => {
    setMsg("Syncing…");
    try {
      const r = await api<{ message: string }>(`/api/integrations/${i.id}/sync`, { method: "POST" });
      setMsg(r.message);
      dataChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    reload();
  };
  const disconnect = async () => {
    await api(`/api/integrations/${i.id}/config`, { method: "DELETE" });
    reload();
  };
  return (
    <div style={{ padding: 12, borderRadius: 10, background: "var(--slate-inset)", boxShadow: "0 0 0 1px var(--hairline)" }}>
      <div className="hstack between">
        <div>
          <div style={{ fontWeight: 600 }}>{i.name}</div>
          <div className="tiny">{i.connected ? `Connected${i.account ? ` as ${i.account}` : ""}${i.lastRunAt ? ` · synced ${ago(i.lastRunAt)}` : ""}` : i.description}</div>
        </div>
        {i.connected ? <button className="btn small ghost" onClick={() => void disconnect()}>Disconnect</button> : <a className="btn small" href={`/api/integrations/${i.id}/connect`} aria-disabled={!i.config.clientId}>Connect</a>}
      </div>
      {i.lastError && <div className="error" style={{ marginTop: 8 }}>{i.lastError}</div>}
      <div className="form-grid" style={{ marginTop: 12 }}>
        {i.fields.map((f) =>
          f.type === "boolean" ? (
            <div key={f.key} className="hstack between wide">
              <span>{f.label}</span>
              <Switch label={f.label} checked={!!cfg[f.key]} onChange={(x) => setCfg({ ...cfg, [f.key]: x })} />
            </div>
          ) : (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <input className="input" type={f.secret ? "password" : "text"} value={String(cfg[f.key] ?? "")} placeholder={f.help} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} autoComplete="off" />
            </label>
          ),
        )}
      </div>
      <div className="hstack between" style={{ marginTop: 12 }}>
        <span className="tiny">{msg ?? (i.id === "strava" ? `Callback domain: ${location.host}` : "")}</span>
        <div className="hstack">
          {i.connected && <button className="btn small ghost" onClick={() => void sync()}>Sync now</button>}
          <button className="btn small" onClick={() => void saveCfg()}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Webhooks() {
  const r = useApi<{ events: string[]; webhooks: { id: number; url: string; events: string[]; last_status: number | null; last_error: string | null; last_delivery_at: number | null }[] }>("/api/webhooks");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["recovery.scored", "workout.created"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null);
    try {
      const h = await api<{ secret: string }>("/api/webhooks", { method: "POST", json: { url, events } });
      setSecret(h.secret);
      setUrl("");
      r.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="card flush">
      <div className="card-head" style={{ padding: "16px 16px 0" }}><h2>Webhooks</h2></div>
      <div className="rows">
        {r.data?.webhooks.map((h) => (
          <Row key={h.id} title={<span style={{ wordBreak: "break-all" }}>{h.url}</span>} sub={`${h.events.join(", ")}${h.last_delivery_at ? ` · last ${h.last_status ?? "error"} ${ago(h.last_delivery_at)}` : ""}`} right={
            <div className="hstack">
              <button className="btn small ghost" onClick={() => void api(`/api/webhooks/${h.id}/test`, { method: "POST" }).then(r.reload)}>Test</button>
              <button className="btn small danger" onClick={() => void api(`/api/webhooks/${h.id}`, { method: "DELETE" }).then(r.reload)}>Delete</button>
            </div>
          } />
        ))}
        <div className="row" style={{ display: "grid", gap: 10 }}>
          <input className="input" placeholder="https://example.com/hooks/openwhoop" value={url} onChange={(e) => setUrl(e.target.value)} />
          <div className="hstack wrap" style={{ gap: 8 }}>
            {r.data?.events.map((e) => (
              <button key={e} className="btn small ghost" aria-pressed={events.includes(e)} style={events.includes(e) ? { background: "var(--chalk)", color: "#000" } : undefined} onClick={() => setEvents(events.includes(e) ? events.filter((x) => x !== e) : [...events, e])}>{e}</button>
            ))}
          </div>
          {err && <span className="error">{err}</span>}
          {secret && <div className="notice info" style={{ wordBreak: "break-all" }}>Signing secret (shown once): <code>{secret}</code></div>}
          <button className="btn small" onClick={() => void create()} disabled={!url || !events.length}>Add webhook</button>
          <span className="tiny">Each POST carries <code>X-OpenWhoop-Signature: sha256=HMAC(secret, "timestamp.body")</code>.</span>
        </div>
      </div>
    </section>
  );
}

function Tokens() {
  const r = useApi<{ id: number; name: string; prefix: string; scope: string; created_at: number; last_used_at: number | null }[]>("/api/tokens");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [token, setToken] = useState<string | null>(null);
  const create = async () => {
    const t = await api<{ token: string }>("/api/tokens", { method: "POST", json: { name, scope } });
    setToken(t.token);
    setName("");
    r.reload();
  };
  return (
    <section className="card flush">
      <div className="card-head" style={{ padding: "16px 16px 0" }}><h2>API tokens</h2></div>
      <div className="rows">
        {r.data?.map((t) => (
          <Row key={t.id} title={t.name} sub={`${t.prefix}… · ${t.scope} · ${t.last_used_at ? `used ${ago(t.last_used_at)}` : "never used"}`} right={<button className="btn small danger" onClick={() => void api(`/api/tokens/${t.id}`, { method: "DELETE" }).then(r.reload)}>Revoke</button>} />
        ))}
        <div className="row" style={{ display: "grid", gap: 10 }}>
          <div className="hstack">
            <input className="input" placeholder="Token name, e.g. Home Assistant" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="input" style={{ width: 120 }} value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
              <option value="read">Read</option>
              <option value="write">Read+write</option>
            </select>
          </div>
          {token && <div className="notice info" style={{ wordBreak: "break-all" }}>Copy it now: <code>{token}</code><br /><span className="tiny">curl -H "Authorization: Bearer {token.slice(0, 10)}…" {location.origin}/api/overview</span></div>}
          <button className="btn small" onClick={() => void create()} disabled={!name}>Create token</button>
        </div>
      </div>
    </section>
  );
}

function Account() {
  const st = useApi<{ mode: string; hasPassword: boolean; envPassword: boolean }>("/api/auth/state");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const change = async () => {
    try {
      await api("/api/auth/password", { method: "POST", json: { current: cur || undefined, next } });
      setMsg("Password saved. Other sessions were signed out.");
      setCur("");
      setNext("");
      st.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/";
  };
  return (
    <Card title="Access">
      {st.data?.envPassword ? (
        <p className="tiny">The password comes from <code>OPENWHOOP_PASSWORD</code>.</p>
      ) : (
        <div className="form-grid">
          {st.data?.hasPassword && <label className="field"><span>Current</span><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>}
          <label className={`field${st.data?.hasPassword ? "" : " wide"}`}><span>{st.data?.hasPassword ? "New password" : "Set a password"}</span><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} autoComplete="new-password" /></label>
        </div>
      )}
      {msg && <p className="tiny" style={{ marginTop: 8 }}>{msg}</p>}
      <div className="hstack between" style={{ marginTop: 12 }}>
        <span className="tiny">{st.data?.hasPassword ? "This instance is locked." : "No password: open to anyone who can reach this machine's localhost."}</span>
        <div className="hstack">
          {st.data?.hasPassword && <button className="btn small ghost" onClick={() => void logout()}>Sign out</button>}
          {!st.data?.envPassword && <button className="btn small" onClick={() => void change()} disabled={next.length < 8}>Save</button>}
        </div>
      </div>
    </Card>
  );
}
