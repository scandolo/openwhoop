import { useState } from "react";
import { api, dataChanged, useApi } from "../api.ts";
import { DayRibbon, Dial } from "../components/charts.tsx";
import { TopBar, useDate } from "../components/TopBar.tsx";
import { Card, ErrorNote, Loading, Meter, Row, Stat } from "../components/ui.tsx";
import { clock, fixed, hm, sportName, SPORTS } from "../format.ts";
import type { DayData, Overview, Workout } from "../types.ts";

const ZONES = ["Zone 0", "Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"];
const ZONE_COLORS = ["rgba(243,245,247,0.25)", "#5aa9e6", "#2d8fdc", "#0f76c7", "#0b5ca8", "#06428a"];
const BAND = { light: "Light", moderate: "Moderate", high: "High", all_out: "All out" } as Record<string, string>;

export function StrainPage() {
  const [date, setDate] = useDate();
  const q = date ? `?date=${date}` : "";
  const ov = useApi<Overview>(`/api/overview${q}`);
  const day = useApi<DayData>(`/api/day${q}`);
  const top = <TopBar date={date} prevDate={ov.data?.prevDate} nextDate={ov.data?.nextDate} latestDate={ov.data?.latestDate} onDate={setDate} back={`/${q}`} />;
  if (ov.error) return <>{top}<ErrorNote error={ov.error} retry={ov.reload} /></>;
  if (!ov.data || !ov.data.strain) return <>{top}<Loading /></>;
  const s = ov.data.strain;
  const zoneTotal = s.zoneSeconds.reduce((a, b) => a + b, 0) || 1;
  return (
    <>
      {top}
      <div style={{ maxWidth: 260, margin: "0 auto" }}>
        <Dial label={`${BAND[s.band] ?? ""} strain`} fraction={s.strain / 21} color="var(--strain)" value={s.strain.toFixed(1)} />
      </div>
      <p className="muted" style={{ textAlign: "center", margin: "4px 0 20px" }}>
        Target for today {ov.data.strainTarget.low}–{ov.data.strainTarget.high}, set by your recovery.
      </p>
      <div className="grid2">
        <div className="stack">
          <Card title="Heart rate">
            {day.data && <DayRibbon minutes={day.data.minutes} start={day.data.start} end={day.data.end ?? Date.now() / 1000} restingHr={day.data.physiology.restingHr} maxHr={day.data.physiology.maxHr} />}
          </Card>
          <Card title="Time in heart-rate zones" action={day.data ? <span className="tiny num">max {day.data.physiology.maxHr} bpm</span> : undefined}>
            <div className="stack" style={{ gap: 10 }}>
              {s.zoneSeconds.map((sec, i) => (
                <div key={i} className="stagebar" style={{ gridTemplateColumns: "64px 1fr 56px" }}>
                  <span className="muted">{ZONES[i]}</span>
                  <Meter fraction={sec / zoneTotal} color={ZONE_COLORS[i]!} />
                  <span className="num" style={{ textAlign: "right" }}>{hm(sec / 60)}</span>
                </div>
              ))}
            </div>
            <p className="tiny" style={{ marginTop: 12 }}>Zones use your heart-rate reserve: zone 1 starts at 50%, zone 5 at 90%.</p>
          </Card>
        </div>
        <div className="stack">
          <div className="stats">
            <Stat label="Calories" value={s.kcal.toLocaleString()} unit="kcal" />
            <Stat label="Average HR" value={fixed(s.avgHr)} unit="bpm" />
            <Stat label="Max HR" value={fixed(s.maxHr)} unit="bpm" />
            <Stat label="Load" value={fixed(s.load)} detail="weighted zone-minutes" />
          </div>
          <Card title="Activities" flush>
            <div className="rows">
              {ov.data.workouts.length === 0 && <Row title={<span className="muted">No activities</span>} />}
              {ov.data.workouts.map((w) => <WorkoutRow key={w.id} w={w} />)}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function WorkoutRow({ w }: { w: Workout }) {
  const [editing, setEditing] = useState(false);
  const [sport, setSport] = useState(w.sport);
  const save = async () => {
    await api(`/api/workouts/${w.id}`, { method: "PATCH", json: { sport, name: SPORTS[sport] } });
    setEditing(false);
    dataChanged();
  };
  const remove = async () => {
    await api(`/api/workouts/${w.id}`, { method: "DELETE" });
    dataChanged();
  };
  if (editing)
    return (
      <div className="row">
        <select className="input" value={sport} onChange={(e) => setSport(e.target.value)} style={{ flex: 1 }}>
          {Object.entries(SPORTS).filter(([k], i, a) => a.findIndex(([, v]) => v === SPORTS[k]) === i).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn small" onClick={() => void save()}>Save</button>
        <button className="btn small danger" onClick={() => void remove()}>Delete</button>
      </div>
    );
  return (
    <Row
      left={<span className="badge-strain num">{fixed(w.strain, 1)}</span>}
      title={sportName(w.sport, w.name)}
      sub={`${clock(w.start)} · ${Math.round((w.end - w.start) / 60)} min${w.avg_hr ? ` · avg ${Math.round(w.avg_hr)} · max ${Math.round(w.max_hr ?? 0)}` : ""}${w.kcal ? ` · ${Math.round(w.kcal)} kcal` : ""}`}
      right={w.meta?.url ? <a className="tiny" href={w.meta.url} target="_blank" rel="noreferrer" style={{ color: "var(--strain)" }}>Strava ↗</a> : <button className="btn small ghost" onClick={() => setEditing(true)}>Edit</button>}
    />
  );
}
