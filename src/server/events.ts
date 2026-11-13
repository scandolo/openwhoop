// In-process event bus. Every event is logged to the events table and fanned
// out to listeners (webhooks, built-in integrations). Listeners never block
// the caller and their failures are only logged.
import { now, run, type Db } from "./db.ts";

export const EVENT_TYPES = [
  "sync.completed",
  "sleep.scored",
  "recovery.scored",
  "workout.created",
  "stress.high",
  "journal.updated",
  "alarm.fired",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AppEvent {
  type: EventType;
  ts: number;
  data: Record<string, unknown>;
}

type Listener = (e: AppEvent) => void | Promise<void>;
const listeners: Listener[] = [];

export function onEvent(fn: Listener) {
  listeners.push(fn);
}

export function emit(db: Db, type: EventType, data: Record<string, unknown>) {
  const e: AppEvent = { type, ts: now(), data };
  run(db, "INSERT INTO events (ts, type, data) VALUES (?, ?, ?)", e.ts, type, JSON.stringify(data));
  for (const fn of listeners) {
    Promise.resolve()
      .then(() => fn(e))
      .catch((err) => console.error(`[events] listener failed for ${type}:`, err));
  }
}
