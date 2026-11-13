import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { api } from "../api.ts";
import { useDevice } from "../ble/device.tsx";
import { IconClose } from "../components/icons.tsx";
import { clock, pad } from "../format.ts";

interface Plan {
  enabled: boolean;
  mode: "exact" | "sleep_goal" | "in_the_green";
  latestWakeAt: number;
  windowStartAt: number;
  goalPct: number;
}

const MODE = { exact: "Exact time", sleep_goal: "Sleep goal", in_the_green: "In the green" };

export function Night() {
  const d = useDevice();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [status, setStatus] = useState("Starting…");
  const [fired, setFired] = useState(false);
  const [now, setNow] = useState(new Date());
  const firedRef = useRef(false);
  const connected = d.status === "connected" || d.status === "syncing";

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // keep the screen on while night mode runs
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const get = () => navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    void get();
    const vis = () => document.visibilityState === "visible" && void get();
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      void lock?.release();
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    let stop = false;
    (async () => {
      const p = await api<Plan>("/api/alarm/plan");
      setPlan(p);
      if (!p.enabled) return setStatus("Alarm is off — turn it on in Settings. Night mode still syncs your sleep.");
      await d.strap.setStrapAlarm(p.latestWakeAt).catch(() => setStatus("Couldn't set the strap's backup alarm"));
      setStatus(p.mode === "exact" ? `Strap alarm set for ${clock(p.latestWakeAt)}` : `Backup alarm set on the strap for ${clock(p.latestWakeAt)}`);
      while (!stop && !firedRef.current) {
        const nowS = Date.now() / 1000;
        const inWindow = nowS >= p.windowStartAt - 300;
        if (p.mode !== "exact" && inWindow) {
          await d.sync();
          const dec = await api<{ wake: boolean; reason: string }>(`/api/alarm/decision?latestWakeAt=${p.latestWakeAt}`).catch(() => null);
          if (dec) setStatus(dec.reason);
          if (dec?.wake) {
            firedRef.current = true;
            setFired(true);
            await d.strap.wakeUp().catch(() => d.strap.buzz(0, 2, 3));
            await d.strap.clearStrapAlarm();
            void api("/api/alarm/fired", { method: "POST", json: { reason: dec.reason } });
            break;
          }
        } else if (nowS >= p.latestWakeAt) {
          setFired(true);
          firedRef.current = true;
          break;
        } else {
          await d.sync(); // keep the night's data flowing so staging is up to date
        }
        await new Promise((r) => setTimeout(r, (inWindow ? 3 : 15) * 60_000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fullscreen" style={{ color: fired ? "var(--chalk)" : "rgba(243,245,247,0.6)" }}>
      <div className="hstack between">
        <span className="label">Night mode</span>
        <Link href="/" className="iconbtn" aria-label="Exit night mode"><IconClose /></Link>
      </div>
      <div style={{ display: "grid", alignContent: "center", gap: 16, textAlign: "center" }}>
        <div className="big-clock">{pad(now.getHours())}:{pad(now.getMinutes())}</div>
        {fired ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 600 }}>Good morning</div>
            <button className="btn" style={{ margin: "0 auto" }} onClick={() => void d.strap.stopBuzz()}>Stop alarm</button>
          </>
        ) : plan?.enabled ? (
          <div className="muted">{MODE[plan.mode]} · {plan.mode === "exact" ? clock(plan.latestWakeAt) : `${clock(plan.windowStartAt)} – ${clock(plan.latestWakeAt)}`}</div>
        ) : null}
        {!connected && <div className="notice warn" style={{ margin: "0 auto", maxWidth: 360 }}>Connect your strap first — <Link href="/device" style={{ color: "var(--strain)" }}>Strap</Link></div>}
      </div>
      <p className="tiny" style={{ textAlign: "center" }}>{status}<br />Keep this screen plugged in. If it closes, the strap still wakes you at the latest time.</p>
    </div>
  );
}
