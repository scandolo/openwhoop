import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, dataChanged } from "../api.ts";
import { useDevice } from "../ble/device.tsx";
import { hrrFraction, loadFromStrain, strainFromHr, strainFromLoad, zoneOf } from "../../algorithms/strain.ts";
import type { Physiology } from "../../algorithms/strain.ts";
import { Dial } from "../components/charts.tsx";
import { IconClose } from "../components/icons.tsx";
import { pad, SPORTS } from "../format.ts";
import type { Overview } from "../types.ts";

export function LiveWorkout() {
  const d = useDevice();
  const [, go] = useLocation();
  const [sport, setSport] = useState("running");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [phys, setPhys] = useState<Physiology | null>(null);
  const [day, setDay] = useState<{ strain: number; target: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [, force] = useState(0);
  const hr = useRef<number[]>([]); // per second since start
  const buzzed = useRef(false);
  const connected = d.status === "connected" || d.status === "syncing";

  useEffect(() => {
    void api<{ physiology: { restingHr: number; maxHr: number }; profile: { weightKg: number; heightCm: number; birthYear: number | null; sex: "male" | "female" } }>("/api/settings").then((s) =>
      setPhys({ ...s.physiology, weightKg: s.profile.weightKg, heightCm: s.profile.heightCm, age: s.profile.birthYear ? new Date().getFullYear() - s.profile.birthYear : 30, sex: s.profile.sex }),
    );
    void api<Overview>("/api/overview").then((o) => o.strain && setDay({ strain: o.strain.strain, target: o.strainTarget.low }));
  }, []);

  useEffect(() => {
    if (!connected) return;
    void d.startLive();
    return () => void d.stopLive();
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // sample the latest beat once a second while running
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => {
      const b = d.beats.at(-1);
      hr.current.push(b && Date.now() - b.t < 5000 ? b.hr : NaN);
      force((x) => x + 1);
    }, 1000);
    return () => clearInterval(t);
  });

  const res = phys ? strainFromHr(Float32Array.from(hr.current), phys) : null;
  const dayStrain = day && res ? strainFromLoad(loadFromStrain(day.strain) + res.load) : null;
  useEffect(() => {
    if (day && dayStrain !== null && dayStrain >= day.target && !buzzed.current && startedAt) {
      buzzed.current = true;
      void d.strap.buzz(250).then(() => setTimeout(() => void d.strap.buzz(250), 600));
      void api("/api/log", { method: "POST", json: { type: "strain.target", data: { strain: dayStrain, live: true } } });
    }
  });

  const live = d.live && Date.now() - d.live.t < 5000 ? d.live.hr : null;
  const zone = live && phys ? zoneOf(hrrFraction(live, phys.restingHr, phys.maxHr)) : null;
  const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  const stop = async () => {
    setSaving(true);
    const end = Math.floor(Date.now() / 1000);
    await d.sync().catch(() => undefined); // bring the strap's own record of the workout to the server
    await api("/api/workouts", { method: "POST", json: { start: Math.floor(startedAt! / 1000), end, sport, name: SPORTS[sport], source: "live" } });
    dataChanged();
    go("/strain");
  };

  return (
    <div className="fullscreen">
      <div className="hstack between">
        <span className="label">Live workout</span>
        <button className="iconbtn" aria-label="Close" onClick={() => go("/")} disabled={!!startedAt}><IconClose /></button>
      </div>
      <div style={{ display: "grid", alignContent: "center", gap: 20, textAlign: "center" }}>
        <div style={{ maxWidth: 240, margin: "0 auto", width: "100%" }}>
          <Dial label="Activity strain" fraction={(res?.strain ?? 0) / 21} color="var(--strain)" value={(res?.strain ?? 0).toFixed(1)} />
        </div>
        <div className="hstack" style={{ justifyContent: "center", gap: 36 }}>
          <div><div className="label">Heart rate</div><div className="num" style={{ fontSize: 40, fontWeight: 600, color: "var(--red)" }}>{live ?? "—"}</div></div>
          <div><div className="label">Zone</div><div className="num" style={{ fontSize: 40, fontWeight: 600 }}>{zone ?? "—"}</div></div>
          <div><div className="label">Time</div><div className="num" style={{ fontSize: 40, fontWeight: 600 }}>{pad(Math.floor(elapsed / 60))}:{pad(elapsed % 60)}</div></div>
        </div>
        {dayStrain !== null && day && <div className="muted">Day strain {dayStrain.toFixed(1)} · target {day.target}</div>}
      </div>
      <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        {!connected ? (
          <span className="notice warn">Connect your strap to track live. <Link href="/device" style={{ color: "var(--strain)" }}>Strap</Link></span>
        ) : startedAt ? (
          <button className="btn danger" onClick={() => void stop()} disabled={saving}>{saving ? "Saving…" : "Finish"}</button>
        ) : (
          <>
            <select className="input" style={{ maxWidth: 240 }} value={sport} onChange={(e) => setSport(e.target.value)}>
              {["running", "cycling", "strength", "hiit", "walking", "swim", "yoga", "rowing", "tennis", "soccer"].map((s) => <option key={s} value={s}>{SPORTS[s]}</option>)}
            </select>
            <button className="btn blue" onClick={() => { hr.current = []; setStartedAt(Date.now()); }}>Start</button>
          </>
        )}
      </div>
    </div>
  );
}
