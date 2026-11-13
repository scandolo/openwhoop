import { useApi } from "../api.ts";
import { Hypnogram, LineChart } from "../components/charts.tsx";
import { TopBar, useDate } from "../components/TopBar.tsx";
import { Card, ErrorNote, Loading, Meter, Stat } from "../components/ui.tsx";
import { clock, fixed, hm } from "../format.ts";
import type { CycleView, SleepMetrics, StageSegment } from "../types.ts";

interface SleepData extends CycleView {
  date: string;
  stages: StageSegment[] | null;
  hr: { ts: number; hr: number | null; rmssd: number | null }[];
  naps: { start: number; end: number; metrics: SleepMetrics | null }[];
}

const BAND_TEXT = { optimal: "Optimal", sufficient: "Sufficient", poor: "Poor" } as const;

export function SleepPage() {
  const [date, setDate] = useDate();
  const q = date ? `?date=${date}` : "";
  const r = useApi<SleepData | null>(`/api/sleep${q}`);
  const nav = useApi<{ prevDate: string | null; nextDate: string | null; latestDate: string | null }>(`/api/overview${q}`);
  const top = <TopBar date={date} prevDate={nav.data?.prevDate} nextDate={nav.data?.nextDate} latestDate={nav.data?.latestDate} onDate={setDate} back={`/${q}`} />;
  if (r.error) return <>{top}<ErrorNote error={r.error} retry={r.reload} /></>;
  if (!r.data) return <>{top}{r.loading ? <Loading /> : <div className="empty"><h2>No sleep yet</h2></div>}</>;
  const s = r.data.sleep;
  if (!s) return <>{top}<div className="empty"><h2>No sleep recorded</h2></div></>;
  const m = s.metrics;
  const stages: [string, number, string][] = [
    ["Awake", m.awake, "var(--awake)"],
    ["Light", m.light, "var(--light-sleep)"],
    ["Deep", m.deep, "var(--deep)"],
    ["REM", m.rem, "var(--rem)"],
  ];
  return (
    <>
      {top}
      <section style={{ textAlign: "center", padding: "8px 0 20px" }}>
        <div className="label" style={{ color: "var(--sleep)" }}>Sleep performance</div>
        <div className="num" style={{ fontSize: 72, fontWeight: 600, lineHeight: 1.05 }}>{s.performance}<span style={{ fontSize: 28, color: "var(--chalk-3)" }}>%</span></div>
        <div className="muted">{BAND_TEXT[s.band]} · {hm(m.asleep / 60)} of {hm(s.need.total)} needed</div>
      </section>

      <div className="grid2">
        <div className="stack">
          <Card title="Stages" action={<span className="tiny num">{clock(m.start)} – {clock(m.end)}</span>}>
            {r.data.stages && <Hypnogram stages={r.data.stages} />}
            <div className="stack" style={{ marginTop: 16, gap: 10 }}>
              {stages.map(([label, sec, color]) => (
                <div key={label} className="stagebar">
                  <span className="muted">{label}</span>
                  <Meter fraction={sec / m.inBed} color={color} />
                  <span className="num" style={{ textAlign: "right" }}>{hm(sec / 60)} <span className="muted">{Math.round((100 * sec) / m.inBed)}%</span></span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Heart rate & HRV during sleep">
            <LineChart values={r.data.hr.map((x) => x.hr)} color="var(--chalk-2)" height={110} dots={false} />
            <LineChart values={r.data.hr.map((x) => x.rmssd)} color="var(--sleep)" height={90} dots={false} />
            <div className="legend"><span><i style={{ background: "var(--chalk-2)" }} />Heart rate</span><span><i style={{ background: "var(--sleep)" }} />HRV (RMSSD)</span></div>
          </Card>
        </div>
        <div className="stack">
          <div className="stats">
            <Stat label="Hours vs needed" value={Math.round(Math.min(100, (100 * m.asleep) / 60 / s.need.total))} unit="%" detail={`${hm(m.asleep / 60)} / ${hm(s.need.total)}`} />
            <Stat label="Consistency" value={s.consistency ?? "—"} unit={s.consistency != null ? "%" : undefined} detail={s.consistency == null ? "after 4 nights" : "timing vs last 4 days"} />
            <Stat label="Efficiency" value={Math.round(m.efficiency * 100)} unit="%" detail={`${hm(m.awake / 60)} awake in bed`} />
            <Stat label="Restorative" value={Math.round(m.restorative * 100)} unit="%" detail="deep + REM" />
            <Stat label="Resp. rate" value={fixed(m.respRate, 1)} unit="rpm" detail="from heart-rate rhythm" />
            <Stat label="Disturbances" value={m.disturbances} detail={`${m.cycles} sleep cycles`} />
          </div>
          <Card title="Why you needed it">
            <div className="stack" style={{ gap: 8 }}>
              <NeedRow label="Baseline" min={s.need.baseline} />
              <NeedRow label="From strain" min={s.need.strain} />
              <NeedRow label="Sleep debt" min={s.need.debt} />
              <NeedRow label="Naps" min={s.need.naps} />
              <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 8 }}>
                <NeedRow label="Total need" min={s.need.total} strong />
              </div>
            </div>
          </Card>
          {r.data.naps.length > 0 && (
            <Card title="Naps">
              {r.data.naps.map((n) => (
                <div key={n.start} className="hstack between">
                  <span>{clock(n.start)} – {clock(n.end)}</span>
                  <span className="num">{hm((n.metrics?.asleep ?? 0) / 60)}</span>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function NeedRow({ label, min, strong }: { label: string; min: number; strong?: boolean }) {
  return (
    <div className="hstack between" style={{ fontWeight: strong ? 600 : 400 }}>
      <span className={strong ? undefined : "muted"}>{label}</span>
      <span className="num">{min < 0 ? "−" : min > 0 && !strong ? "+" : ""}{hm(Math.abs(min))}</span>
    </div>
  );
}
