import { Link, useLocation, useSearch } from "wouter";
import { useDevice } from "../ble/device.tsx";
import { ago, dayLabel } from "../format.ts";
import { IconLeft, IconRight } from "./icons.tsx";

/** `?date=YYYY-MM-DD` in the URL; null = the current cycle. */
export function useDate(): [string | null, (d: string | null) => void] {
  const search = useSearch();
  const [loc, go] = useLocation();
  const date = new URLSearchParams(search).get("date");
  return [date, (d) => go(d ? `${loc}?date=${d}` : loc)];
}

export function StrapChip(props: { lastSyncAt?: number | null; battery?: number | null }) {
  const d = useDevice();
  const connected = d.status === "connected" || d.status === "syncing";
  const text = d.status === "syncing" ? "Syncing" : connected ? `${Math.round(d.battery ?? props.battery ?? 0)}%` : props.lastSyncAt ? ago(props.lastSyncAt) : "Connect";
  return (
    <Link href="/device" className="strap-chip" aria-label="Strap status">
      <span className={`dot${d.status === "syncing" ? " busy" : connected ? " on" : ""}`} />
      {text}
    </Link>
  );
}

export function TopBar(props: { date: string | null; prevDate?: string | null; nextDate?: string | null; latestDate?: string | null; onDate: (d: string | null) => void; title?: string; back?: string; lastSyncAt?: number | null; battery?: number | null }) {
  return (
    <header className="topbar">
      {props.back ? (
        <Link href={props.back} className="iconbtn" aria-label="Back">
          <IconLeft />
        </Link>
      ) : (
        <span style={{ width: 40 }} />
      )}
      <div className="datenav">
        <button className="iconbtn" aria-label="Previous day" disabled={!props.prevDate} onClick={() => props.onDate(props.prevDate ?? null)}>
          <IconLeft />
        </button>
        <span className="when">{props.title ?? dayLabel(props.date ?? props.latestDate ?? null, props.latestDate)}</span>
        <button className="iconbtn" aria-label="Next day" disabled={!props.nextDate} onClick={() => props.onDate(props.nextDate === props.latestDate ? null : props.nextDate ?? null)}>
          <IconRight />
        </button>
      </div>
      <StrapChip lastSyncAt={props.lastSyncAt} battery={props.battery} />
    </header>
  );
}
