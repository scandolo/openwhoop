import { Link } from "wouter";
import { useApi } from "../api.ts";
import { StressChart } from "../components/charts.tsx";
import { TopBar, useDate } from "../components/TopBar.tsx";
import { Card, ErrorNote, Loading, Stat } from "../components/ui.tsx";
import { fixed, hm, stressColor } from "../format.ts";
import type { DayData, Overview } from "../types.ts";

export function StressPage() {
  const [date, setDate] = useDate();
  const q = date ? `?date=${date}` : "";
  const ov = useApi<Overview>(`/api/overview${q}`);
  const day = useApi<DayData>(`/api/day${q}`);
  const top = <TopBar date={date} prevDate={ov.data?.prevDate} nextDate={ov.data?.nextDate} latestDate={ov.data?.latestDate} onDate={setDate} back={`/${q}`} />;
  if (ov.error) return <>{top}<ErrorNote error={ov.error} retry={ov.reload} /></>;
  if (!ov.data) return <>{top}<Loading /></>;
  const st = ov.data.stress;
  const v = st.current ?? st.avg;
  return (
    <>
      {top}
      <section style={{ textAlign: "center", padding: "8px 0 20px" }}>
        <div className="label">Stress monitor</div>
        <div className="num" style={{ fontSize: 72, fontWeight: 600, lineHeight: 1.05, color: stressColor(v) }}>{fixed(v, 1)}</div>
        <div className="muted">{st.current != null ? "Right now" : "Day average"} · {v == null ? "—" : v < 1 ? "Low" : v < 2 ? "Medium" : "High"}</div>
      </section>
      <div className="stack">
        <Card title="Through the day">{day.data ? <StressChart minutes={day.data.minutes} /> : <div className="skeleton" style={{ height: 130 }} />}</Card>
        <div className="stats three">
          <Stat label="Low" value={hm(st.minutes.low)} color="var(--calm)" />
          <Stat label="Medium" value={hm(st.minutes.medium)} color="var(--yellow)" />
          <Stat label="High" value={hm(st.minutes.high)} color="var(--tense)" />
        </div>
        <Card title="About this score">
          <p className="tiny">
            Each still, awake minute compares your heart rate and HRV with your own 14-day baseline: 1.0 is your typical calm, 2+ means your body is running hot. Movement and workouts are left out. With the strap connected, sustained high stress triggers a gentle buzz and a breathing prompt.
          </p>
        </Card>
        <Link href="/breathe" className="btn blue block">Start a breathing session</Link>
      </div>
    </>
  );
}
