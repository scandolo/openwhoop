import { useState } from "react";
import { useApi } from "../api.ts";
import { Bars, LineChart } from "../components/charts.tsx";
import { Card, ErrorNote, Loading, Segmented } from "../components/ui.tsx";
import { fixed, recoveryColor } from "../format.ts";
import type { TrendPoint } from "../types.ts";

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export function Trends() {
  const [days, setDays] = useState(30);
  const r = useApi<TrendPoint[]>(`/api/trends?days=${days}`);
  const t = r.data ?? [];
  const labels = t.map((p) => (days <= 30 ? p.date.slice(8) : p.date.slice(5)));
  const card = (title: string, key: keyof TrendPoint, color: string, unit: string, digits = 0, extra: Partial<Parameters<typeof LineChart>[0]> = {}) => (
    <Card title={title} action={<span className="num" style={{ fontWeight: 600 }}>{fixed(avg(t.map((p) => p[key] as number | null)), digits)}<span className="tiny"> {unit} avg</span></span>}>
      <LineChart values={t.map((p) => p[key] as number | null)} labels={labels} color={color} format={(v) => v.toFixed(digits)} {...extra} />
    </Card>
  );
  return (
    <>
      <header className="topbar">
        <h1 className="page-title" style={{ margin: 0 }}>Trends</h1>
        <Segmented value={days} onChange={setDays} options={[{ value: 7, label: "1W" }, { value: 30, label: "1M" }, { value: 90, label: "3M" }, { value: 180, label: "6M" }]} />
      </header>
      {r.error && <ErrorNote error={r.error} retry={r.reload} />}
      {!r.data ? (
        <Loading />
      ) : t.length < 2 ? (
        <div className="empty"><h2>Not enough data</h2><p>Trends fill in after a few nights.</p></div>
      ) : (
        <div className="grid2">
          <div className="stack">
            <Card title="Recovery" action={<span className="num" style={{ fontWeight: 600, color: recoveryColor(avg(t.map((p) => p.recovery))) }}>{fixed(avg(t.map((p) => p.recovery)))}%<span className="tiny"> avg</span></span>}>
              <Bars values={t.map((p) => p.recovery)} labels={labels} max={100} color={(v) => recoveryColor(v)} />
            </Card>
            {card("HRV", "hrv", "var(--chalk)", "ms")}
            {card("Resting heart rate", "rhr", "var(--red)", "bpm")}
            {card("Respiratory rate", "resp", "var(--calm)", "rpm", 1)}
          </div>
          <div className="stack">
            <Card title="Strain" action={<span className="num" style={{ fontWeight: 600, color: "var(--strain)" }}>{fixed(avg(t.map((p) => p.strain)), 1)}<span className="tiny"> avg</span></span>}>
              <Bars values={t.map((p) => p.strain)} labels={labels} max={21} color={() => "var(--strain)"} format={(v) => v.toFixed(1)} />
            </Card>
            {card("Sleep performance", "sleepPerformance", "var(--sleep)", "%", 0, { min: 0, max: 100 })}
            <Card title="Hours vs needed" action={<span className="num" style={{ fontWeight: 600 }}>{fixed(avg(t.map((p) => p.asleepH)), 1)}<span className="tiny"> h avg</span></span>}>
              <LineChart values={t.map((p) => p.asleepH)} labels={labels} color="var(--sleep)" format={(v) => v.toFixed(1)} baseline={avg(t.map((p) => p.needH))} />
              <div className="legend"><span><i style={{ background: "var(--sleep)" }} />Asleep</span><span>Dashed: average need</span></div>
            </Card>
            {card("Skin temperature (experimental)", "skinTempDev", "var(--tense)", "°C", 1)}
          </div>
        </div>
      )}
    </>
  );
}
