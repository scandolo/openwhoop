// Hand-drawn SVG charts. One visual grammar: hairline grid, 2px data strokes,
// colour only where it carries meaning (recovery band, strain, stage, stress).
import { useCallback, useId, useRef, useState } from "react";
import { clock, recoveryColor, stressColor } from "../format.ts";

/** Charts draw in real pixels so labels stay legible at any card width. */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(600);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    const measure = (x: number) => setW(Math.max(200, Math.round(x)));
    measure(el.getBoundingClientRect().width);
    ro.current = new ResizeObserver(([e]) => measure(e!.contentRect.width));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

// ── Dial ──────────────────────────────────────────────────────────────
export function Dial(props: { fraction: number; color: string; value: string; unit?: string; label: string; sub?: string | null; onClick?: () => void; pending?: boolean }) {
  const r = 52, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, props.fraction));
  return (
    <button className="dial" onClick={props.onClick} aria-label={`${props.label}: ${props.value}${props.unit ?? ""}`}>
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        {!props.pending && (
          <circle cx="60" cy="60" r={r} fill="none" stroke={props.color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 60 60)" style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.23,1,0.32,1)" }} />
        )}
        <foreignObject x="10" y="34" width="100" height="52">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", height: "100%" }}>
            <span className="value" style={{ fontSize: 34, color: props.pending ? "var(--chalk-4)" : undefined }}>{props.value}</span>
            {props.unit && <span className="unit">{props.unit}</span>}
          </div>
        </foreignObject>
      </svg>
      <span className="label">{props.label}</span>
      {props.sub && <span className="tiny num" style={{ marginTop: -4 }}>{props.sub}</span>}
    </button>
  );
}

// ── Line chart (trends) ───────────────────────────────────────────────
export function LineChart(props: { values: (number | null)[]; labels?: string[]; color: string; height?: number; min?: number; max?: number; baseline?: number | null; format?: (v: number) => string; dots?: boolean }) {
  const [box, W] = useWidth();
  const H = props.height ?? 140;
  const pad = { l: 6, r: 34, t: 10, b: 20 };
  const data = props.values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!data.length) return <div className="tiny" style={{ padding: "24px 0", textAlign: "center" }}>No data yet</div>;
  const vals = props.baseline != null && Number.isFinite(props.baseline) ? [...data, props.baseline] : data;
  const lo = props.min ?? Math.min(...vals) - (Math.max(...vals) - Math.min(...vals)) * 0.15;
  const hi = props.max ?? Math.max(...vals) + (Math.max(...vals) - Math.min(...vals)) * 0.15 + 0.001;
  const n = props.values.length;
  const x = (i: number) => pad.l + (n === 1 ? 0.5 : i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  let d = "";
  props.values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    const prev = props.values[i - 1];
    d += `${prev === null || prev === undefined || !Number.isFinite(prev) ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const fmt = props.format ?? ((v: number) => v.toFixed(0));
  const ticks = [lo + (hi - lo) * 0.2, lo + (hi - lo) * 0.8];
  const every = Math.max(1, Math.ceil(n / 6));
  return (
    <div ref={box}><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img">
      <g className="grid">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text x={W - pad.r + 6} y={y(t) + 3}>{fmt(t)}</text>
          </g>
        ))}
      </g>
      {props.baseline !== null && props.baseline !== undefined && <line x1={pad.l} x2={W - pad.r} y1={y(props.baseline)} y2={y(props.baseline)} stroke="var(--chalk-4)" strokeDasharray="3 4" />}
      <path d={d} fill="none" stroke={props.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {props.dots !== false && n <= 45 && props.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill={props.color} />))}
      {props.labels?.map((l, i) => (i % every === 0 || i === n - 1 ? <text key={i} x={x(i)} y={H - 4} textAnchor="middle">{l}</text> : null))}
    </svg></div>
  );
}

// ── Bars (recovery history, strain history) ───────────────────────────
export function Bars(props: { values: (number | null)[]; labels?: string[]; max: number; color: (v: number) => string; height?: number; format?: (v: number) => string; selected?: number }) {
  const [box, W] = useWidth();
  const H = props.height ?? 140;
  const pad = { l: 2, r: 2, t: 16, b: 20 };
  const n = props.values.length;
  const bw = (W - pad.l - pad.r) / Math.max(1, n);
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <div ref={box}><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img">
      {props.values.map((v, i) => {
        if (v === null) return null;
        const h = Math.max(2, (v / props.max) * (H - pad.t - pad.b));
        const xx = pad.l + i * bw + bw * 0.18;
        return (
          <g key={i} opacity={props.selected === undefined || props.selected === i ? 1 : 0.55}>
            <rect x={xx} y={H - pad.b - h} width={bw * 0.64} height={h} rx={Math.min(3, bw * 0.2)} fill={props.color(v)} />
            {n <= 14 && <text x={xx + bw * 0.32} y={H - pad.b - h - 5} textAnchor="middle" style={{ fill: "var(--chalk-3)" }}>{props.format ? props.format(v) : v.toFixed(0)}</text>}
          </g>
        );
      })}
      {props.labels?.map((l, i) => (i % every === 0 ? <text key={i} x={pad.l + i * bw + bw / 2} y={H - 4} textAnchor="middle">{l}</text> : null))}
    </svg></div>
  );
}

// ── Hypnogram ─────────────────────────────────────────────────────────
type Stage = "wake" | "light" | "deep" | "rem";
const LANES: { stage: Stage; label: string; color: string }[] = [
  { stage: "wake", label: "Awake", color: "var(--awake)" },
  { stage: "rem", label: "REM", color: "var(--rem)" },
  { stage: "light", label: "Light", color: "var(--light-sleep)" },
  { stage: "deep", label: "Deep", color: "var(--deep)" },
];

export function Hypnogram(props: { stages: { start: number; end: number; stage: Stage }[]; height?: number }) {
  const [box, W] = useWidth();
  const H = props.height ?? 176;
  const pad = { l: 46, r: 6, t: 6, b: 22 };
  if (!props.stages.length) return null;
  const t0 = props.stages[0]!.start, t1 = props.stages.at(-1)!.end;
  const lane = (s: Stage) => LANES.findIndex((l) => l.stage === s);
  const lh = (H - pad.t - pad.b) / LANES.length;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const yc = (s: Stage) => pad.t + lane(s) * lh + lh / 2;
  let step = "";
  props.stages.forEach((g, i) => {
    step += `${i ? "L" : "M"}${x(g.start).toFixed(1)},${yc(g.stage).toFixed(1)}L${x(g.end).toFixed(1)},${yc(g.stage).toFixed(1)}`;
  });
  const hours: number[] = [];
  for (let t = Math.ceil(t0 / 3600) * 3600; t < t1; t += 3600) hours.push(t);
  const every = hours.length > 8 ? 2 : 1;
  return (
    <div ref={box}><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sleep stages through the night">
      <g className="grid">
        {LANES.map((l, i) => (
          <g key={l.stage}>
            <line x1={pad.l} x2={W - pad.r} y1={pad.t + (i + 1) * lh} y2={pad.t + (i + 1) * lh} />
            <text x={0} y={pad.t + i * lh + lh / 2 + 3}>{l.label.toUpperCase()}</text>
          </g>
        ))}
      </g>
      <path d={step} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
      {props.stages.map((g, i) => (
        <rect key={i} x={x(g.start)} y={yc(g.stage) - lh * 0.32} width={Math.max(1, x(g.end) - x(g.start))} height={lh * 0.64} rx="2" fill={LANES[lane(g.stage)]!.color} />
      ))}
      {hours.map((t, i) => (i % every === 0 ? <text key={t} x={x(t)} y={H - 5} textAnchor="middle">{clock(t)}</text> : null))}
    </svg></div>
  );
}

// ── Day ribbon: heart rate across the physiological cycle ────────────
export interface Minute {
  ts: number;
  hr: number | null;
  stress: number | null;
  state: string;
}

export function DayRibbon(props: { minutes: Minute[]; start: number; end: number; restingHr: number; maxHr: number; height?: number }) {
  const [box, W] = useWidth();
  const H = props.height ?? 150;
  const pad = { l: 4, r: 34, t: 8, b: 20 };
  const id = useId();
  if (props.minutes.length < 10) return <div className="tiny" style={{ padding: "28px 0", textAlign: "center" }}>Heart rate appears here after a sync</div>;
  const t0 = props.start, t1 = Math.max(props.end, props.minutes.at(-1)!.ts + 60);
  const lo = Math.max(30, props.restingHr - 15), hi = Math.max(props.maxHr * 0.92, ...props.minutes.map((m) => m.hr ?? 0)) + 5;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  // shaded spans for sleep and workouts
  const spans: { a: number; b: number; kind: string }[] = [];
  for (const m of props.minutes) {
    const last = spans.at(-1);
    if (m.state !== "sleep" && m.state !== "workout") continue;
    if (last && last.kind === m.state && m.ts - last.b <= 120) last.b = m.ts + 60;
    else spans.push({ a: m.ts, b: m.ts + 60, kind: m.state });
  }
  let d = "";
  let prevT = -1;
  for (const m of props.minutes) {
    if (m.hr === null) {
      prevT = -1;
      continue;
    }
    d += `${prevT < 0 || m.ts - prevT > 180 ? "M" : "L"}${x(m.ts).toFixed(1)},${y(m.hr).toFixed(1)}`;
    prevT = m.ts;
  }
  const zone = (f: number) => props.restingHr + f * (props.maxHr - props.restingHr);
  const hours: number[] = [];
  for (let t = Math.ceil(t0 / (3 * 3600)) * 3 * 3600; t < t1; t += 3 * 3600) hours.push(t);
  return (
    <div ref={box}><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Heart rate through the day">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--strain)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--strain)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {spans.map((s, i) => (
        <rect key={i} x={x(s.a)} y={pad.t} width={Math.max(1, x(s.b) - x(s.a))} height={H - pad.t - pad.b} fill={s.kind === "sleep" ? "rgba(123,161,187,0.10)" : "rgba(0,147,231,0.14)"} />
      ))}
      <g className="grid">
        {[0.5, 0.7, 0.9].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(zone(f))} y2={y(zone(f))} strokeDasharray="2 5" />
            <text x={W - pad.r + 6} y={y(zone(f)) + 3}>{Math.round(zone(f))}</text>
          </g>
        ))}
      </g>
      <path d={d} fill="none" stroke="var(--chalk-2)" strokeWidth="1.5" strokeLinejoin="round" />
      {hours.map((t) => (
        <text key={t} x={x(t)} y={H - 5} textAnchor="middle">{clock(t)}</text>
      ))}
    </svg></div>
  );
}

// ── Stress (0-3) ─────────────────────────────────────────────────────
export function StressChart(props: { minutes: Minute[]; height?: number }) {
  const [box, W] = useWidth();
  const H = props.height ?? 130;
  const pad = { l: 4, r: 24, t: 8, b: 20 };
  const pts = props.minutes.filter((m) => m.stress !== null);
  if (pts.length < 10) return <div className="tiny" style={{ padding: "28px 0", textAlign: "center" }}>Stress is scored while you're still and awake</div>;
  const t0 = props.minutes[0]!.ts, t1 = props.minutes.at(-1)!.ts + 60;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / 3) * (H - pad.t - pad.b);
  const hours: number[] = [];
  for (let t = Math.ceil(t0 / (3 * 3600)) * 3 * 3600; t < t1; t += 3 * 3600) hours.push(t);
  return (
    <div ref={box}><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stress through the day">
      <g className="grid">
        {[1, 2, 3].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text x={W - pad.r + 6} y={y(v) + 3}>{v}</text>
          </g>
        ))}
      </g>
      {pts.map((m) => (
        <rect key={m.ts} x={x(m.ts)} y={y(m.stress!)} width={Math.max(1, x(m.ts + 60) - x(m.ts))} height={y(0) - y(m.stress!)} fill={stressColor(m.stress)} opacity={m.state === "sleep" ? 0.35 : 0.85} />
      ))}
      {hours.map((t) => (
        <text key={t} x={x(t)} y={H - 5} textAnchor="middle">{clock(t)}</text>
      ))}
    </svg></div>
  );
}

export { recoveryColor };
