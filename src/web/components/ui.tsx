import type { ReactNode } from "react";
import { Link } from "wouter";

export function Card(props: { title?: string; action?: ReactNode; children: ReactNode; flush?: boolean; href?: string; className?: string }) {
  const body = (
    <>
      {(props.title || props.action) && (
        <div className="card-head" style={props.flush ? { padding: "16px 16px 0" } : undefined}>
          {props.title && <h2>{props.title}</h2>}
          {props.action}
        </div>
      )}
      {props.children}
    </>
  );
  const cls = `card${props.flush ? " flush" : ""}${props.className ? " " + props.className : ""}`;
  return props.href ? <Link href={props.href} className={cls}>{body}</Link> : <section className={cls}>{body}</section>;
}

export function Stat(props: { label: string; value: ReactNode; unit?: string; detail?: ReactNode; color?: string }) {
  return (
    <div className="stat">
      <span className="label">{props.label}</span>
      <span className="v" style={props.color ? { color: props.color } : undefined}>
        {props.value}
        {props.unit && <small>{props.unit}</small>}
      </span>
      {props.detail !== undefined && <span className="d">{props.detail}</span>}
    </div>
  );
}

/** Delta vs baseline; `good` says which direction is good. */
export function Delta(props: { value: number | null | undefined; unit?: string; digits?: number; good: "up" | "down"; suffix?: string }) {
  const v = props.value;
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="flat">—</span>;
  const small = Math.abs(v) < (props.digits ? 0.5 * 10 ** -props.digits : 0.5);
  const cls = small ? "flat" : (v > 0) === (props.good === "up") ? "up" : "down";
  return (
    <span className={cls}>
      {small ? "±" : v > 0 ? "▲ " : "▼ "}
      {Math.abs(v).toFixed(props.digits ?? 0)}
      {props.unit}
      {props.suffix && <span className="flat"> {props.suffix}</span>}
    </span>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button className="switch" role="switch" aria-checked={props.checked} aria-label={props.label} disabled={props.disabled} onClick={() => props.onChange(!props.checked)} />;
}

export function Segmented<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group">
      {props.options.map((o) => (
        <button key={String(o.value)} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Meter(props: { fraction: number; color: string }) {
  return (
    <div className="meter">
      <span style={{ width: `${Math.max(0, Math.min(1, props.fraction)) * 100}%`, background: props.color }} />
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true">
      <div className="skeleton" style={{ height: 160 }} />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 88 }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="notice warn" role="alert">
      <span style={{ flex: 1 }}>{error}</span>
      {retry && (
        <button className="btn small ghost" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Row(props: { title: ReactNode; sub?: ReactNode; right?: ReactNode; left?: ReactNode; href?: string; onClick?: () => void }) {
  const inner = (
    <>
      {props.left}
      <div className="grow">
        <div className="title">{props.title}</div>
        {props.sub && <div className="sub">{props.sub}</div>}
      </div>
      {props.right && <div className="right">{props.right}</div>}
    </>
  );
  if (props.href) return <Link href={props.href} className="row">{inner}</Link>;
  if (props.onClick)
    return (
      <button className="row" onClick={props.onClick} style={{ width: "100%", border: 0, borderTop: "1px solid var(--hairline)", background: "none", textAlign: "left", cursor: "pointer" }}>
        {inner}
      </button>
    );
  return <div className="row">{inner}</div>;
}
