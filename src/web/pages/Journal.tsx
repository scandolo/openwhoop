import { useEffect, useState } from "react";
import { api, dataChanged, useApi } from "../api.ts";
import { TopBar, useDate } from "../components/TopBar.tsx";
import { Card, ErrorNote, Loading } from "../components/ui.tsx";

interface JournalData {
  date: string;
  questions: { id: string; label: string }[];
  answers: Record<string, boolean>;
}
interface InsightsData {
  days: number;
  insights: { behaviour: string; label: string; yes: number; no: number; effect: number; relative: number; low: number; high: number; confident: boolean; hrvEffectPct: number | null; rhrEffect: number | null }[];
}

const shift = (date: string, d: number) => {
  const t = new Date(date + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

export function Journal() {
  const [date, setDate] = useDate();
  const j = useApi<JournalData>(`/api/journal${date ? `?date=${date}` : ""}`);
  const ins = useApi<InsightsData>("/api/insights");
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (j.data) setAnswers(j.data.answers);
    setSaved(false);
  }, [j.data]);
  const d = j.data;
  const today = new Date().toISOString().slice(0, 10);
  const save = async () => {
    await api("/api/journal", { method: "PUT", json: { date: d!.date, answers } });
    setSaved(true);
    dataChanged();
  };
  const label = d ? new Date(d.date + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : "";
  return (
    <>
      <TopBar date={d?.date ?? null} prevDate={d ? shift(d.date, -1) : null} nextDate={d && shift(d.date, 1) < today ? shift(d.date, 1) : null} onDate={(x) => setDate(x)} title={label ? label.split(",")[0] : "Journal"} />
      <div className="grid2">
        <div className="stack">
          <Card title={`Journal · ${label}`}>
            {j.error && <ErrorNote error={j.error} />}
            {!d ? (
              <div className="skeleton" style={{ height: 220 }} />
            ) : (
              <>
                <p className="tiny" style={{ marginBottom: 8 }}>About the day and evening before your sleep. Answers line up with the next morning's recovery.</p>
                <div className="rows" style={{ margin: "0 -16px" }}>
                  {d.questions.map((q) => (
                    <div key={q.id} className="row">
                      <div className="grow">{q.label}</div>
                      <div className="yesno">
                        <button aria-pressed={answers[q.id] === true} onClick={() => setAnswers({ ...answers, [q.id]: true })}>Yes</button>
                        <button aria-pressed={answers[q.id] === false} onClick={() => setAnswers({ ...answers, [q.id]: false })}>No</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="hstack between" style={{ marginTop: 12 }}>
                  <span className="tiny">{saved ? "Saved" : `${Object.keys(answers).length} of ${d.questions.length} answered`}</span>
                  <button className="btn small" onClick={() => void save()} disabled={!Object.keys(answers).length}>Save</button>
                </div>
              </>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title="What affects your recovery">
            {!ins.data ? (
              <Loading rows={0} />
            ) : ins.data.insights.length === 0 ? (
              <p className="tiny">Insights unlock once a behaviour has at least 5 “yes” and 5 “no” answers on nights with a recovery score. {ins.data.days} scored days logged so far.</p>
            ) : (
              <div className="stack" style={{ gap: 18 }}>
                {ins.data.insights.map((i) => <InsightRow key={i.behaviour} i={i} />)}
                <p className="tiny">Effect = difference in next-morning recovery, adjusted for the previous day's strain, with a 95% interval. Grey means the data can't tell yet.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function InsightRow({ i }: { i: InsightsData["insights"][number] }) {
  // scale: ±30 recovery points across the track
  const pos = (v: number) => `${50 + Math.max(-50, Math.min(50, (v / 30) * 50))}%`;
  const color = !i.confident ? "var(--chalk-3)" : i.effect > 0 ? "var(--green)" : "var(--red)";
  return (
    <div>
      <div className="hstack between" style={{ marginBottom: 8 }}>
        <span>{i.label.replace(/\?$/, "")}</span>
        <span className="num" style={{ fontWeight: 600, color }}>{i.effect > 0 ? "+" : "−"}{Math.abs(i.effect).toFixed(0)}<span className="tiny"> pts</span></span>
      </div>
      <div style={{ position: "relative", height: 14 }}>
        <div style={{ position: "absolute", top: 6, left: 0, right: 0, height: 2, background: "var(--hairline-strong)", borderRadius: 2 }} />
        <div style={{ position: "absolute", top: 0, left: "50%", width: 1, height: 14, background: "var(--chalk-4)" }} />
        <div style={{ position: "absolute", top: 5, left: pos(i.low), width: `calc(${pos(i.high)} - ${pos(i.low)})`, height: 4, borderRadius: 2, background: color, opacity: 0.45 }} />
        <div style={{ position: "absolute", top: 2, left: `calc(${pos(i.effect)} - 5px)`, width: 10, height: 10, borderRadius: "50%", background: color }} />
      </div>
      <div className="tiny" style={{ marginTop: 6 }}>
        {i.yes} yes · {i.no} no
        {i.hrvEffectPct != null && ` · HRV ${i.hrvEffectPct > 0 ? "+" : "−"}${Math.abs(i.hrvEffectPct).toFixed(0)}%`}
        {i.rhrEffect != null && ` · RHR ${i.rhrEffect > 0 ? "+" : "−"}${Math.abs(i.rhrEffect).toFixed(1)} bpm`}
      </div>
    </div>
  );
}
