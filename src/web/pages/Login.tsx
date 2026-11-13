import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { BrandMark } from "../components/icons.tsx";

export function Login({ mode, onDone }: { mode: string; onDone: () => void }) {
  const setup = mode === "setup";
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (setup && pw !== pw2) return setErr("Passwords don't match");
    setBusy(true);
    try {
      await api(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", json: setup ? { password: pw, token } : { password: pw } });
      history.replaceState(null, "", "/");
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="brand" style={{ justifyContent: "center", marginBottom: 8 }}>
          <BrandMark className="brand-mark" style={{ color: "var(--green)", width: 28, height: 28 }} />
          OpenWhoop
        </div>
        <p className="muted" style={{ textAlign: "center" }}>
          {setup ? "First run. Choose the password that protects this instance." : "This instance is private. Enter your password."}
        </p>
        {setup && !token && <div className="notice warn">Open the setup link printed in the server log — it carries a one-time token.</div>}
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoComplete={setup ? "new-password" : "current-password"} value={pw} onChange={(e) => setPw(e.target.value)} minLength={setup ? 8 : undefined} required autoFocus />
        </label>
        {setup && (
          <label className="field">
            <span>Repeat password</span>
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
          </label>
        )}
        {err && <div className="error" role="alert">{err}</div>}
        <button className="btn block" disabled={busy || !pw}>
          {setup ? "Create password" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
