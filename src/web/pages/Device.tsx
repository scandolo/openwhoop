import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useApi } from "../api.ts";
import { useDevice } from "../ble/device.tsx";
import { HAPTIC } from "../../protocol/commands.ts";
import { Card, ErrorNote, Row, Stat, Switch } from "../components/ui.tsx";
import { IconBolt, IconHeart, IconMoon, IconWind } from "../components/icons.tsx";
import { ago, fixed } from "../format.ts";

export function Device() {
  const d = useDevice();
  const stored = useApi<{ id: string; name: string | null; battery: number | null; firmware: string | null; last_sync_at: number | null } | null>("/api/device");
  const connected = d.status === "connected" || d.status === "syncing";
  const [live, setLive] = useState(false);
  useEffect(() => () => void (live && d.stopLive()), [live]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <header className="topbar">
        <h1 className="page-title" style={{ margin: 0 }}>Strap</h1>
      </header>
      <div className="grid2">
        <div className="stack">
          <Card title="Connection">
            {d.status === "unsupported" ? (
              <div className="notice warn">This browser can't talk to Bluetooth devices. Open OpenWhoop in Chrome or Edge on a computer or an Android phone (on iPhone, the Bluefy browser works).</div>
            ) : (
              <div className="stack">
                <div className="hstack between">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 18 }}>{connected ? d.name : stored.data?.name ?? "No strap connected"}</div>
                    <div className="tiny">{connected ? `Connected${d.serial ? ` · ${d.serial}` : ""}${d.firmware ? ` · fw ${d.firmware}` : ""}` : stored.data?.last_sync_at ? `Last sync ${ago(stored.data.last_sync_at)}` : "Pair once; Chrome remembers it."}</div>
                  </div>
                  {connected ? <button className="btn small ghost" onClick={d.disconnect}>Disconnect</button> : <button className="btn small" onClick={() => void d.connect()} disabled={d.status === "connecting"}>{d.status === "connecting" ? "Connecting…" : "Connect"}</button>}
                </div>
                {d.error && <ErrorNote error={d.error} />}
                <p className="tiny">The strap talks to one device at a time — quit the official WHOOP app (or turn off the phone's Bluetooth) before connecting.</p>
              </div>
            )}
          </Card>

          <Card title="Sync">
            <SyncPanel />
          </Card>

          {connected && (
            <Card title="Live heart rate" action={<Switch label="Live heart rate" checked={live} onChange={(v) => { setLive(v); void (v ? d.startLive() : d.stopLive()); }} />}>
              <div className="hstack" style={{ gap: 16 }}>
                <IconHeart width={36} height={36} style={{ color: live && d.live ? "var(--red)" : "var(--chalk-4)" }} />
                <div className="num" style={{ fontSize: 48, fontWeight: 600, lineHeight: 1 }}>{live && d.live ? d.live.hr : "—"}<span className="tiny"> bpm</span></div>
              </div>
            </Card>
          )}
        </div>

        <div className="stack">
          <div className="stats">
            <Stat label="Battery" value={fixed(connected ? d.battery : stored.data?.battery ?? null)} unit="%" />
            <Stat label="Last sync" value={<span style={{ fontSize: 20 }}>{ago(d.lastSync?.at ?? stored.data?.last_sync_at)}</span>} />
          </div>
          <Card title="Modes" flush>
            <div className="rows">
              <Row href="/night" left={<IconMoon width={22} height={22} style={{ color: "var(--sleep)" }} />} title="Night mode & smart alarm" sub="Wakes you in light sleep, inside your window" />
              <Row href="/breathe" left={<IconWind width={22} height={22} style={{ color: "var(--calm)" }} />} title="Breathe" sub="Haptic-paced breathing with live HRV" />
              <Row href="/live" left={<IconBolt width={22} height={22} style={{ color: "var(--strain)" }} />} title="Live workout" sub="Live strain, zones and target buzz" />
            </div>
          </Card>
          {connected && (
            <Card title="Haptics">
              <div className="hstack wrap">
                <button className="btn small ghost" onClick={() => void d.strap.buzz(200)}>Tap</button>
                <button className="btn small ghost" onClick={() => void d.strap.buzz(900)}>Buzz</button>
                <button className="btn small ghost" onClick={() => void d.strap.buzz(0, HAPTIC.ALARM, 2)}>Alarm pattern</button>
                <button className="btn small ghost" onClick={() => void d.strap.stopBuzz()}>Stop</button>
              </div>
              <p className="tiny" style={{ marginTop: 10 }}>Double-tap the strap any time to start a breathing session.</p>
            </Card>
          )}
          <Link href="/settings#haptics" className="tiny" style={{ color: "var(--strain)" }}>Haptic automations →</Link>
        </div>
      </div>
    </>
  );
}

function SyncPanel() {
  const d = useDevice();
  const connected = d.status === "connected" || d.status === "syncing";
  const p = d.progress;
  const behind = p?.newestTs ? Math.max(0, Date.now() / 1000 - p.newestTs) : null;
  const rate = p && p.frames > 0 ? p.frames / ((Date.now() - p.startedAt) / 1000) : null;
  const eta = behind !== null && rate ? behind / rate : null;
  return (
    <div className="stack">
      {d.status === "syncing" && p ? (
        <>
          <div className="hstack between">
            <span>Downloading history…</span>
            <span className="num muted">{p.frames.toLocaleString()} records</span>
          </div>
          <div className="meter">
            <span style={{ width: behind !== null ? `${Math.max(3, (100 * p.frames) / (p.frames + behind))}%` : "3%", background: "var(--strain)", transition: "width 600ms" }} />
          </div>
          <div className="tiny">
            {behind !== null ? `${Math.round(behind / 3600)} h of data still on the strap` : "Waiting for the strap…"}
            {eta !== null && eta > 60 ? ` · about ${Math.round(eta / 60)} min left` : ""}. Each batch is saved before the strap is told it can free it, so you can stop any time.
          </div>
          <button className="btn small ghost" onClick={d.cancelSync}>Stop</button>
        </>
      ) : (
        <div className="hstack between">
          <span className="tiny">{d.lastSync ? `Synced ${d.lastSync.frames.toLocaleString()} records ${ago(d.lastSync.at)}` : "The strap stores days of data; syncing runs at the strap's pace (~10 seconds of data per second)."}</span>
          <button className="btn small" onClick={() => void d.sync()} disabled={!connected}>Sync now</button>
        </div>
      )}
      {d.notice && <div className="notice info">{d.notice}</div>}
      <div className="hstack between" style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
        <div>
          <div>Companion mode</div>
          <div className="tiny">Read without freeing the strap's memory, so the official WHOOP app still receives everything. Turn off if you don't use the WHOOP app.</div>
        </div>
        <Switch label="Companion mode" checked={d.companion} onChange={d.setCompanion} />
      </div>
      <div className="hstack between" style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
        <div>
          <div>Keep syncing</div>
          <div className="tiny">Every 10 min while this tab stays open. Powers stress nudges and the strain-target buzz.</div>
        </div>
        <Switch label="Keep syncing" checked={d.keepSynced} onChange={d.setKeepSynced} />
      </div>
    </div>
  );
}
