import { useApi } from "../api.ts";
import { Bars, Dial } from "../components/charts.tsx";
import { TopBar, useDate } from "../components/TopBar.tsx";
import { Card, Delta, ErrorNote, Loading, Stat } from "../components/ui.tsx";
import { fixed, recoveryColor } from "../format.ts";
import type { Overview, TrendPoint } from "../types.ts";

const BAND = { green: "Your body is ready for strain.", yellow: "Maintaining — moderate strain fits today.", red: "Your body needs rest — keep strain light." } as const;

export function RecoveryPage() {
  const [date, setDate] = useDate();
  const q = date ? `?date=${date}` : "";
  const ov = useApi<Overview>(`/api/overview${q}`);
  const tr = useApi<TrendPoint[]>("/api/trends?days=30");
  const top = <TopBar date={date} prevDate={ov.data?.prevDate} nextDate={ov.data?.nextDate} latestDate={ov.data?.latestDate} onDate={setDate} back={`/${q}`} />;
  if (ov.error) return <>{top}<ErrorNote error={ov.error} retry={ov.reload} /></>;
  if (!ov.data) return <>{top}<Loading /></>;
  const r = ov.data.recovery;
  if (!r) return <>{top}<div className="empty"><h2>No recovery</h2><p>Recovery is scored from a full night of sleep.</p></div></>;
  const contribs = [
    { label: "HRV", v: r.contributions.hrv },
    { label: "Resting HR", v: r.contributions.rhr },
    { label: "Resp. rate", v: r.contributions.resp },
  ];
  const trend = tr.data ?? [];
  return (
    <>
      {top}
      <div style={{ maxWidth: 260, margin: "0 auto" }}>
        <Dial label="Recovery" fraction={(r.score ?? 0) / 100} color={recoveryColor(r.score)} value={r.score != null ? String(r.score) : "…"} unit={r.score != null ? "%" : undefined} pending={r.score == null} />
      </div>
      <p style={{ textAlign: "center", margin: "4px 0 20px" }} className="muted">{r.band ? BAND[r.band] : "Still learning your baseline."}</p>

      <div className="grid2">
        <div className="stack">
          <div className="stats">
            <Stat label="HRV" value={fixed(r.hrv)} unit="ms" detail={<Delta value={r.deltas.hrvPct} unit="%" good="up" suffix="vs baseline" />} />
            <Stat label="Resting HR" value={fixed(r.rhr)} unit="bpm" detail={<Delta value={r.deltas.rhr} good="down" suffix="vs baseline" />} />
            <Stat label="Resp. rate" value={fixed(r.resp, 1)} unit="rpm" detail={<Delta value={r.deltas.resp} digits={1} good="down" suffix="vs baseline" />} />
            <Stat label="Sleep" value={ov.data.sleep?.performance ?? "—"} unit="%" detail="sleep performance" />
            <Stat label="Skin temp" value={r.deltas.skinTemp != null ? `${r.deltas.skinTemp > 0 ? "+" : ""}${r.deltas.skinTemp.toFixed(1)}` : "—"} unit="°C" detail="vs baseline · experimental" />
            <Stat label="SpO₂" value="—" detail="not readable on 4.0 yet" />
          </div>
          <Card title="What moved it">
            <p className="tiny" style={{ marginBottom: 12 }}>Each night is compared with your own recent baseline. Bars show how much each signal pushed today's score up or down.</p>
            <div className="stack" style={{ gap: 10 }}>
              {contribs.map((c) => (
                <div key={c.label} style={{ display: "grid", gridTemplateColumns: "88px 1fr", alignItems: "center", gap: 12 }}>
                  <span className="muted">{c.label}</span>
                  <Diverging v={c.v} />
                </div>
              ))}
            </div>
          </Card>
        </div>
        <div className="stack">
          <Card title="Last 30 days" action={ov.data.baselines.recovery != null ? <span className="tiny num">avg {Math.round(ov.data.baselines.recovery)}%</span> : undefined}>
            <Bars values={trend.map((t) => t.recovery)} labels={trend.map((t) => t.date.slice(8))} max={100} color={(v) => recoveryColor(v)} />
          </Card>
          <Card title="How it's calculated">
            <p className="tiny">
              A logistic model of last night's HRV, resting heart rate and breathing rate against a personal baseline (exponentially weighted, 7-night half-life), plus sleep performance. Its weights were fitted to 4,000+ nights of real WHOOP exports and track WHOOP's own score with a median day-to-day correlation of 0.93. It is an independent estimate, not WHOOP's algorithm.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Diverging({ v }: { v: number }) {
  const w = Math.min(50, Math.abs(v) * 40);
  return (
    <div className="meter" style={{ height: 10 }}>
      <span style={{ left: "50%", width: 1, background: "var(--chalk-4)" }} />
      <span style={v >= 0 ? { left: "50%", width: `${w}%`, background: "var(--green)" } : { left: `${50 - w}%`, width: `${w}%`, background: "var(--red)" }} />
    </div>
  );
}
