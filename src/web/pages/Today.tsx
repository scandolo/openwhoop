import { Link, useLocation } from "wouter";
import { useApi } from "../api.ts";
import { useDevice } from "../ble/device.tsx";
import { DayRibbon, Dial } from "../components/charts.tsx";
import { IconBolt, IconMoon, IconWind } from "../components/icons.tsx";
import { TopBar, useDate } from "../components/TopBar.tsx";
import { Card, Delta, ErrorNote, Loading, Meter, Row, Stat } from "../components/ui.tsx";
import { clock, fixed, hm, recoveryColor, sportName, stressColor } from "../format.ts";
import type { DayData, Overview } from "../types.ts";

export function Today() {
  const [date, setDate] = useDate();
  const q = date ? `?date=${date}` : "";
  const ov = useApi<Overview>(`/api/overview${q}`);
  const day = useApi<DayData>(`/api/day${q}`);
  const [, go] = useLocation();
  const d = ov.data;

  if (ov.error) return <><TopBar date={date} onDate={setDate} /><ErrorNote error={ov.error} retry={ov.reload} /></>;
  if (!d) return <><TopBar date={date} onDate={setDate} /><Loading /></>;
  if (d.empty) return <FirstRun lastSyncAt={d.device?.last_sync_at ?? null} />;

  const rec = d.recovery;
  const sleep = d.sleep;
  const strain = d.strain;
  const dq = date ? `?date=${date}` : "";

  return (
    <>
      <TopBar date={date} prevDate={d.prevDate} nextDate={d.nextDate} latestDate={d.latestDate} onDate={setDate} lastSyncAt={d.device?.last_sync_at} battery={d.device?.battery} />

      <div className="dials">
        <Dial label="Sleep" fraction={(sleep?.performance ?? 0) / 100} color="var(--sleep)" value={sleep ? String(sleep.performance) : "—"} unit={sleep ? "%" : undefined} pending={!sleep} sub={d.whoop?.sleepPerformance != null ? `WHOOP ${d.whoop.sleepPerformance}%` : null} onClick={() => go(`/sleep${dq}`)} />
        <Dial label="Recovery" fraction={(rec?.score ?? 0) / 100} color={recoveryColor(rec?.score)} value={rec?.score != null ? String(rec.score) : rec?.calibrating ? "…" : "—"} unit={rec?.score != null ? "%" : undefined} pending={rec?.score == null} sub={d.whoop?.recovery != null ? `WHOOP ${d.whoop.recovery}%` : null} onClick={() => go(`/recovery${dq}`)} />
        <Dial label="Strain" fraction={(strain?.strain ?? 0) / 21} color="var(--strain)" value={strain ? strain.strain.toFixed(1) : "—"} pending={!strain} sub={d.whoop?.strain != null ? `WHOOP ${d.whoop.strain.toFixed(1)}` : null} onClick={() => go(`/strain${dq}`)} />
      </div>

      <div className="stack" style={{ marginBottom: 12 }}>
        {rec?.calibrating && <div className="notice info">Calibrating your baseline — recovery appears after 3 nights of sleep data.</div>}
        {rec && rec.flags.length > 0 && (
          <div className="notice warn">
            Out of your normal range: {rec.flags.join(", ")}. Several at once is how illness or heavy fatigue usually shows up.
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="stack">
          <Card title={d.isCurrent ? "Your day so far" : "Your day"} action={<span className="tiny num">{clock(d.cycle.start)} – {d.cycle.end ? clock(d.cycle.end) : "now"}</span>}>
            {day.data ? <DayRibbon minutes={day.data.minutes} start={day.data.start} end={day.data.end ?? Date.now() / 1000} restingHr={day.data.physiology.restingHr} maxHr={day.data.physiology.maxHr} /> : <div className="skeleton" style={{ height: 150 }} />}
            <div className="legend" style={{ marginTop: 8 }}>
              <span><i style={{ background: "rgba(123,161,187,0.5)" }} />Sleep</span>
              <span><i style={{ background: "rgba(0,147,231,0.6)" }} />Activity</span>
              <span>Lines: zone 1 · 3 · 5</span>
            </div>
          </Card>

          <Card title="Activities" flush action={d.isCurrent ? <Link href="/live" className="link">+ Start</Link> : undefined}>
            <div className="rows" style={{ marginTop: 4 }}>
              {d.workouts.length === 0 && <Row title={<span className="muted">No activities{d.isCurrent ? " yet" : ""}</span>} sub={d.isCurrent ? "Workouts over 12 minutes are detected automatically" : undefined} />}
              {d.workouts.map((w) => (
                <Row key={w.id} left={<span className="badge-strain num">{fixed(w.strain, 1)}</span>} title={sportName(w.sport, w.name)} sub={`${clock(w.start)} – ${clock(w.end)} · ${Math.round((w.end - w.start) / 60)} min${w.avg_hr ? ` · avg ${Math.round(w.avg_hr)} bpm` : ""}`} right={w.source === "strava" ? <span className="tiny">Strava</span> : w.source === "detected" ? <span className="tiny">Auto</span> : undefined} href={`/strain${dq}`} />
              ))}
            </div>
            {d.isCurrent && strain && (
              <div style={{ padding: 16, borderTop: "1px solid var(--hairline)" }}>
                <div className="hstack between" style={{ marginBottom: 8 }}>
                  <span className="label">Strain target</span>
                  <span className="num" style={{ fontWeight: 600 }}>{d.strainTarget.low}–{d.strainTarget.high}</span>
                </div>
                <TargetMeter value={strain.strain} low={d.strainTarget.low} high={d.strainTarget.high} />
                <p className="tiny" style={{ marginTop: 8 }}>
                  {strain.strain >= d.strainTarget.high ? "Past today's optimal range — more load now costs recovery." : strain.strain >= d.strainTarget.low ? "In today's optimal range." : `${(d.strainTarget.low - strain.strain).toFixed(1)} to reach today's optimal range.`}
                </p>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <div className="stats">
            <Stat label="HRV" value={fixed(rec?.hrv)} unit="ms" detail={<Delta value={rec?.hrv != null && d.baselines.hrv ? rec.hrv - d.baselines.hrv : null} good="up" suffix="vs 30d" />} />
            <Stat label="Resting HR" value={fixed(rec?.rhr)} unit="bpm" detail={<Delta value={rec?.rhr != null && d.baselines.rhr ? rec.rhr - d.baselines.rhr : null} good="down" suffix="vs 30d" />} />
            <Stat label="Resp. rate" value={fixed(rec?.resp ?? sleep?.metrics.respRate, 1)} unit="rpm" detail={<Delta value={rec?.resp != null && d.baselines.resp ? rec.resp - d.baselines.resp : null} digits={1} good="down" suffix="vs 30d" />} />
            <Stat label="Calories" value={strain ? strain.kcal.toLocaleString() : "—"} unit="kcal" detail={strain?.avgHr ? `avg ${Math.round(strain.avgHr)} bpm` : undefined} />
          </div>

          <Card title="Stress monitor" href={`/stress${dq}`}>
            <div className="hstack between">
              <div>
                <div className="num" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1, color: stressColor(d.stress.current ?? d.stress.avg) }}>{fixed(d.stress.current ?? d.stress.avg, 1)}</div>
                <div className="tiny" style={{ marginTop: 6 }}>{d.stress.current != null ? "Now" : "Day average"} · 0–3 scale</div>
              </div>
              <StressSplit m={d.stress.minutes} />
            </div>
          </Card>

          {sleep && (
            <Card title="Last night" href={`/sleep${dq}`}>
              <div className="hstack between">
                <div>
                  <div className="num" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1 }}>{hm(sleep.metrics.asleep / 60)}</div>
                  <div className="tiny" style={{ marginTop: 6 }}>of {hm(sleep.need.total)} needed · {clock(sleep.metrics.start)} – {clock(sleep.metrics.end)}</div>
                </div>
                <IconMoon width={28} height={28} style={{ color: "var(--sleep)" }} />
              </div>
            </Card>
          )}

          {d.tonight && (
            <Card title="Tonight">
              <p className="tiny" style={{ marginBottom: 12 }}>You need <b className="num" style={{ color: "var(--chalk)", fontSize: 15 }}>{hm(d.tonight.needMin)}</b> of sleep to wake at {clock(d.tonight.wakeAt)} fully recovered.</p>
              <div className="stats three">
                {d.tonight.bedtimes.map((b) => (
                  <Stat key={b.goal} label={b.goal === 100 ? "Peak" : b.goal === 85 ? "Perform" : "Get by"} value={clock(b.at)} detail={`${b.goal}% of need`} />
                ))}
              </div>
            </Card>
          )}

          {!d.journal.answered && (
            <Card title="Journal" href={`/journal?date=${d.journal.date}`}>
              <div className="hstack between">
                <p>How was yesterday? A few taps to learn what moves your recovery.</p>
                <span className="link num" style={{ color: "var(--strain)", fontWeight: 700, letterSpacing: ".08em" }}>LOG</span>
              </div>
            </Card>
          )}

          {d.isCurrent && (
            <div className="hstack wrap">
              <Link href="/breathe" className="btn ghost small"><IconWind width={16} height={16} />Breathe</Link>
              <Link href="/night" className="btn ghost small"><IconMoon width={16} height={16} />Night mode</Link>
              <Link href="/live" className="btn ghost small"><IconBolt width={16} height={16} />Live workout</Link>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TargetMeter({ value, low, high }: { value: number; low: number; high: number }) {
  const pct = (x: number) => `${(Math.min(21, x) / 21) * 100}%`;
  return (
    <div className="meter" style={{ height: 10 }}>
      <span style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})`, background: "rgba(0,147,231,0.25)" }} />
      <span style={{ width: pct(value), background: "var(--strain)" }} />
    </div>
  );
}

function StressSplit({ m }: { m: { low: number; medium: number; high: number } }) {
  const total = m.low + m.medium + m.high || 1;
  const rows: [string, number, string][] = [["Low", m.low, "var(--calm)"], ["Medium", m.medium, "var(--yellow)"], ["High", m.high, "var(--tense)"]];
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 150 }}>
      {rows.map(([l, v, c]) => (
        <div key={l} style={{ display: "grid", gridTemplateColumns: "56px 1fr 40px", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span className="muted">{l}</span>
          <Meter fraction={v / total} color={c} />
          <span className="num muted" style={{ textAlign: "right" }}>{hm(v)}</span>
        </div>
      ))}
    </div>
  );
}

function FirstRun({ lastSyncAt }: { lastSyncAt: number | null }) {
  const dev = useDevice();
  return (
    <>
      <TopBar date={null} onDate={() => undefined} title="Welcome" lastSyncAt={lastSyncAt} />
      <div className="empty">
        <h2>Connect your strap</h2>
        <p style={{ maxWidth: 380 }}>OpenWhoop reads your WHOOP 4.0 over Bluetooth, scores sleep, recovery and strain on this machine, and keeps the data here.</p>
        {dev.status === "unsupported" ? (
          <div className="notice warn" style={{ maxWidth: 420, textAlign: "left" }}>This browser has no Web Bluetooth. Use Chrome or Edge on a computer or Android phone.</div>
        ) : (
          <button className="btn" onClick={() => void dev.connect()} disabled={dev.status === "connecting"}>
            {dev.status === "connecting" ? "Connecting…" : "Connect strap"}
          </button>
        )}
        <p className="tiny" style={{ maxWidth: 380 }}>Close the official WHOOP app first — the strap talks to one device at a time. Your first scores appear after the first night.</p>
      </div>
    </>
  );
}
