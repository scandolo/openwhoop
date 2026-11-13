export const pad = (n: number) => String(n).padStart(2, "0");

export function hm(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

export function clock(unix: number | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...opts });
}

export function dayLabel(date: string | null, latest?: string | null): string {
  if (!date) return "Today";
  if (latest && date === latest) return "Today";
  const d = new Date(date + "T12:00:00");
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (latest) {
    const l = new Date(latest + "T12:00:00");
    l.setDate(l.getDate() - 1);
    if (l.toISOString().slice(0, 10) === date) return "Yesterday";
  }
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function ago(unix: number | null | undefined): string {
  if (!unix) return "never";
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const fixed = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d));

export function signed(x: number | null | undefined, d = 0, unit = ""): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const v = x.toFixed(d);
  return `${x > 0 ? "+" : x < 0 ? "−" : "±"}${v.replace("-", "")}${unit}`;
}

export const recoveryColor = (score: number | null | undefined) =>
  score === null || score === undefined ? "var(--chalk-4)" : score >= 67 ? "var(--green)" : score >= 34 ? "var(--yellow)" : "var(--red)";

export const stressColor = (s: number | null | undefined) => (s === null || s === undefined ? "var(--chalk-4)" : s < 1 ? "var(--calm)" : s < 2 ? "var(--yellow)" : "var(--tense)");

export const SPORTS: Record<string, string> = {
  activity: "Activity",
  running: "Running",
  run: "Running",
  cycling: "Cycling",
  ride: "Cycling",
  strength: "Weightlifting",
  weighttraining: "Weightlifting",
  hiit: "HIIT",
  walk: "Walking",
  walking: "Walking",
  swim: "Swimming",
  yoga: "Yoga",
  hike: "Hiking",
  rowing: "Rowing",
  tennis: "Tennis",
  soccer: "Football",
};
export const sportName = (s: string, name?: string | null) => name || SPORTS[s] || s.replace(/^\w/, (c) => c.toUpperCase());
