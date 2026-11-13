import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, Route, Switch, useLocation } from "wouter";
import "./styles.css";
import { api } from "./api.ts";
import { DeviceProvider, useDevice } from "./ble/device.tsx";
import { BrandMark, IconJournal, IconSettings, IconStrap, IconToday, IconTrends } from "./components/icons.tsx";
import { Login } from "./pages/Login.tsx";
import { Today } from "./pages/Today.tsx";
import { SleepPage } from "./pages/SleepPage.tsx";
import { RecoveryPage } from "./pages/RecoveryPage.tsx";
import { StrainPage } from "./pages/StrainPage.tsx";
import { StressPage } from "./pages/StressPage.tsx";
import { Trends } from "./pages/Trends.tsx";
import { Journal } from "./pages/Journal.tsx";
import { Device } from "./pages/Device.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Night } from "./pages/Night.tsx";
import { Breathe } from "./pages/Breathe.tsx";
import { LiveWorkout } from "./pages/LiveWorkout.tsx";

const NAV = [
  { href: "/", label: "Today", icon: IconToday },
  { href: "/trends", label: "Trends", icon: IconTrends },
  { href: "/journal", label: "Journal", icon: IconJournal },
  { href: "/device", label: "Strap", icon: IconStrap },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

function Nav() {
  const [loc] = useLocation();
  const active = (h: string) => (h === "/" ? ["/", "/sleep", "/recovery", "/strain", "/stress"].includes(loc) : loc.startsWith(h));
  return (
    <>
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <BrandMark className="brand-mark" style={{ color: "var(--green)" }} />
          OpenWhoop
        </div>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}>
            <n.icon />
            {n.label}
          </Link>
        ))}
        <div className="rail-foot tiny">Not affiliated with WHOOP, Inc.</div>
      </nav>
      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="tab" aria-current={active(n.href) ? "page" : undefined}>
            <n.icon />
            {n.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

function NudgeBanner() {
  const d = useDevice();
  const [, go] = useLocation();
  useEffect(() => {
    const onTap = () => go("/breathe");
    window.addEventListener("ow:doubletap", onTap);
    return () => window.removeEventListener("ow:doubletap", onTap);
  }, [go]);
  if (!d.nudge) return null;
  return (
    <div className="notice info" style={{ position: "fixed", left: 16, right: 16, bottom: "calc(var(--nav-h) + 16px)", zIndex: 30, maxWidth: 520, margin: "0 auto" }} role="status">
      <span style={{ flex: 1 }}>{d.nudge.text}</span>
      {d.nudge.kind === "stress" && (
        <button className="btn small blue" onClick={() => { d.dismissNudge(); go("/breathe"); }}>
          Breathe
        </button>
      )}
      <button className="btn small ghost" onClick={d.dismissNudge}>
        Dismiss
      </button>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<{ mode: string; authed: boolean } | null>(null);
  const check = () =>
    api<{ mode: string }>("/api/auth/state")
      .then(async (s) => {
        const authed = s.mode === "open" || (await api("/api/settings").then(() => true).catch(() => false));
        setAuth({ mode: s.mode, authed });
      })
      .catch(() => setAuth({ mode: "locked", authed: false }));
  useEffect(() => {
    void check();
    const on = () => setAuth((a) => (a ? { ...a, authed: false } : a));
    window.addEventListener("ow:unauthorized", on);
    return () => window.removeEventListener("ow:unauthorized", on);
  }, []);
  if (!auth) return null;
  if (!auth.authed) return <Login mode={auth.mode} onDone={check} />;
  return (
    <DeviceProvider>
      <Switch>
        <Route path="/night" component={Night} />
        <Route path="/breathe" component={Breathe} />
        <Route path="/live" component={LiveWorkout} />
        <Route>
          <div className="shell">
            <Nav />
            <main className="main">
              <Switch>
                <Route path="/" component={Today} />
                <Route path="/sleep" component={SleepPage} />
                <Route path="/recovery" component={RecoveryPage} />
                <Route path="/strain" component={StrainPage} />
                <Route path="/stress" component={StressPage} />
                <Route path="/trends" component={Trends} />
                <Route path="/journal" component={Journal} />
                <Route path="/device" component={Device} />
                <Route path="/settings" component={Settings} />
                <Route>
                  <div className="empty">
                    <h2>Not found</h2>
                    <Link href="/" className="btn ghost">Back to today</Link>
                  </div>
                </Route>
              </Switch>
            </main>
            <NudgeBanner />
          </div>
        </Route>
      </Switch>
    </DeviceProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
