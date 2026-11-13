import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../api.ts";
import { useDevice } from "../ble/device.tsx";
import { cleanRR, rmssd } from "../../algorithms/hrv.ts";
import { IconClose } from "../components/icons.tsx";
import { Segmented } from "../components/ui.tsx";
import { fixed, pad } from "../format.ts";

/** Resonance breathing (~5.5 breaths/min): a haptic tap at each inhale. */
export function Breathe() {
  const d = useDevice();
  const [, go] = useLocation();
  const [minutes, setMinutes] = useState(3);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<"in" | "out">("out");
  const [left, setLeft] = useState(0);
  const [summary, setSummary] = useState<{ hr0: number | null; hr1: number | null; r0: number | null; r1: number | null } | null>(null);
  const start = useRef<{ t: number; hr: number | null; r: number | null }>({ t: 0, hr: null, r: null });
  const connected = d.status === "connected" || d.status === "syncing";
  const HALF = 5450; // ms per inhale / exhale

  const recent = useMemo(() => {
    const beats = d.beats.filter((b) => Date.now() - b.t < 60_000);
    const rr = cleanRR(beats.flatMap((b) => b.rr));
    return { hr: beats.length ? beats.at(-1)!.hr : null, r: rr.length > 20 ? rmssd(rr) : null };
  }, [d.beats]);

  useEffect(() => {
    if (connected) void d.startLive();
    return () => void (connected && d.stopLive());
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return;
    let inhale = true;
    const tick = () => {
      setPhase(inhale ? "in" : "out");
      if (inhale && connected) void d.strap.buzz(180).catch(() => undefined);
      inhale = !inhale;
    };
    tick();
    const t = setInterval(tick, HALF);
    const end = Date.now() + minutes * 60_000;
    const c = setInterval(() => {
      const l = Math.max(0, end - Date.now());
      setLeft(l);
      if (l === 0) finish();
    }, 250);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = () => {
    start.current = { t: Date.now(), hr: recent.hr, r: recent.r };
    setSummary(null);
    setRunning(true);
  };
  const finish = () => {
    setRunning(false);
    setPhase("out");
    const s = { hr0: start.current.hr, hr1: recent.hr, r0: start.current.r, r1: recent.r };
    setSummary(s);
    if (connected) void d.strap.buzz(0, 2, 1).then(() => setTimeout(() => void d.strap.stopBuzz(), 900));
    void api("/api/log", { method: "POST", json: { type: "breathe.session", data: { seconds: Math.round((Date.now() - start.current.t) / 1000), ...s } } });
  };

  // double-tap toggles the session
  useEffect(() => {
    const on = () => (running ? finish() : begin());
    window.addEventListener("ow:doubletap", on);
    return () => window.removeEventListener("ow:doubletap", on);
  });

  return (
    <div className="fullscreen">
      <div className="hstack between">
        <span className="label">Breathe</span>
        <button className="iconbtn" aria-label="Close" onClick={() => go("/")}><IconClose /></button>
      </div>
      <div style={{ display: "grid", alignContent: "center", gap: 28, textAlign: "center" }}>
        <div className="breath" style={{ transform: `scale(${phase === "in" ? 1.0 : 0.68})` }} />
        <div style={{ fontSize: 22, fontWeight: 600, minHeight: 30 }}>{running ? (phase === "in" ? "Breathe in" : "Breathe out") : summary ? "Nice work" : "Slow breathing, about 5½ breaths a minute"}</div>
        <div className="hstack" style={{ justifyContent: "center", gap: 32 }}>
          <div><div className="label">Heart rate</div><div className="num" style={{ fontSize: 34, fontWeight: 600 }}>{fixed(recent.hr)}</div></div>
          <div><div className="label">HRV · 60 s</div><div className="num" style={{ fontSize: 34, fontWeight: 600, color: "var(--calm)" }}>{fixed(recent.r)}</div></div>
        </div>
        {summary && (
          <p className="muted">
            {summary.r0 && summary.r1 ? `HRV ${summary.r1 >= summary.r0 ? "rose" : "moved"} from ${Math.round(summary.r0)} to ${Math.round(summary.r1)} ms` : "Connect the strap to see your HRV respond"}
            {summary.hr0 && summary.hr1 ? ` · heart rate ${Math.round(summary.hr0)} → ${Math.round(summary.hr1)} bpm` : ""}.
          </p>
        )}
      </div>
      <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        {running ? (
          <>
            <div className="num muted">{pad(Math.floor(left / 60000))}:{pad(Math.floor((left % 60000) / 1000))}</div>
            <button className="btn ghost" onClick={finish}>End</button>
          </>
        ) : (
          <>
            <Segmented value={minutes} onChange={setMinutes} options={[{ value: 1, label: "1 min" }, { value: 3, label: "3 min" }, { value: 5, label: "5 min" }]} />
            <button className="btn blue" onClick={begin}>Start</button>
            {!connected && <span className="tiny">Without the strap you get the visual pacer only. <Link href="/device" style={{ color: "var(--strain)" }}>Connect</Link></span>}
          </>
        )}
      </div>
    </div>
  );
}
