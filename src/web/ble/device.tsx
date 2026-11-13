// Holds the strap connection for the whole app: sync, live heart rate,
// and the haptic automations that run while the browser stays connected.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, dataChanged } from "../api.ts";
import { bluetoothAvailable, Whoop, type LiveBeat } from "./whoop.ts";
import type { StrapEvent } from "../../protocol/device.ts";
import { batteryEvent } from "../../protocol/device.ts";
import { EventNumber } from "../../protocol/constants.ts";

export type Status = "unsupported" | "idle" | "connecting" | "connected" | "syncing" | "error";

export interface SyncProgress {
  frames: number;
  batches: number;
  newestTs: number | null;
  startedAt: number;
}

interface DeviceState {
  status: Status;
  error: string | null;
  name: string | null;
  serial: string | null;
  battery: number | null;
  firmware: string | null;
  progress: SyncProgress | null;
  lastSync: { at: number; frames: number } | null;
  live: LiveBeat | null;
  beats: LiveBeat[]; // last 5 minutes
  keepSynced: boolean;
  /** Leave data on the strap (never acknowledge batches) so the WHOOP app still gets it. */
  companion: boolean;
  notice: string | null;
  nudge: { kind: "stress" | "strain" | "bedtime"; text: string } | null;
}

interface DeviceApi extends DeviceState {
  strap: Whoop;
  connect: () => Promise<void>;
  disconnect: () => void;
  sync: () => Promise<void>;
  cancelSync: () => void;
  setKeepSynced: (v: boolean) => void;
  setCompanion: (v: boolean) => void;
  startLive: () => Promise<void>;
  stopLive: () => Promise<void>;
  dismissNudge: () => void;
}

const Ctx = createContext<DeviceApi | null>(null);
export const useDevice = () => useContext(Ctx)!;

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
};

function inQuiet(start: string, end: string) {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  const [a, b] = [start, end].map((x) => x.split(":").map(Number)).map(([h, mm]) => h! * 60 + mm!);
  return a! <= b! ? m >= a! && m < b! : m >= a! || m < b!;
}

export function DeviceProvider({ children }: { children: ReactNode }) {
  const strap = useMemo(() => new Whoop(), []);
  const [s, setS] = useState<DeviceState>({
    status: bluetoothAvailable() ? "idle" : "unsupported",
    error: null,
    name: null,
    serial: null,
    battery: null,
    firmware: null,
    progress: null,
    lastSync: null,
    live: null,
    beats: [],
    keepSynced: localStorage.getItem("ow:keepSynced") === "1",
    companion: localStorage.getItem("ow:companion") !== "0",
    notice: null,
    nudge: null,
  });
  const set = (p: Partial<DeviceState>) => setS((x) => ({ ...x, ...p }));
  const abort = useRef<AbortController | null>(null);
  const syncing = useRef(false);
  const lastEventId = useRef(0);
  const firedToday = useRef<Record<string, string>>({});
  const companionRef = useRef(s.companion);
  companionRef.current = s.companion;

  const deviceId = () => strap.serial || strap.name;

  // ── automations, evaluated after each sync while connected ──
  const automations = useCallback(async () => {
    try {
      const settings = await api<{ haptics: { stressNudges: boolean; strainTargetBuzz: boolean; bedtimeNudge: boolean; quietStart: string; quietEnd: string } }>("/api/settings");
      const h = settings.haptics;
      const today = new Date().toDateString();
      const once = (key: string) => {
        if (firedToday.current[key] === today) return false;
        firedToday.current[key] = today;
        return true;
      };
      const quiet = inQuiet(h.quietStart, h.quietEnd);
      // stress episodes detected server-side since the last check
      const events = await api<{ id: number; type: string; data: { start: number; end: number; peak: number } }[]>("/api/events?limit=30");
      const fresh = events.filter((e) => e.id > lastEventId.current);
      if (lastEventId.current === 0) lastEventId.current = events[0]?.id ?? 0;
      else if (events[0]) lastEventId.current = events[0].id;
      const stress = fresh.find((e) => e.type === "stress.high" && Date.now() / 1000 - e.data.end < 20 * 60);
      if (h.stressNudges && stress && !quiet) {
        await strap.buzz(350).catch(() => undefined);
        set({ nudge: { kind: "stress", text: `Stress has been high for ${Math.round((stress.data.end - stress.data.start) / 60)} min. One minute of slow breathing?` } });
        void api("/api/log", { method: "POST", json: { type: "stress.nudge", data: stress.data } });
      }
      const ov = await api<{ isCurrent?: boolean; strain?: { strain: number } | null; strainTarget?: { low: number }; tonight?: { bedtimes: { goal: number; at: number }[] } | null }>("/api/overview");
      if (h.strainTargetBuzz && ov.isCurrent && ov.strain && ov.strainTarget && ov.strain.strain >= ov.strainTarget.low && !quiet && once("strain")) {
        await strap.buzz(250).catch(() => undefined);
        setTimeout(() => void strap.buzz(250).catch(() => undefined), 600);
        set({ nudge: { kind: "strain", text: `You reached today's strain target (${ov.strainTarget.low}). Anything more is extra load.` } });
        void api("/api/log", { method: "POST", json: { type: "strain.target", data: { strain: ov.strain.strain } } });
      }
      const bed = ov.tonight?.bedtimes.find((b) => b.goal === 100);
      const nowS = Date.now() / 1000;
      if (h.bedtimeNudge && bed && nowS >= bed.at - 15 * 60 && nowS < bed.at + 30 * 60 && once("bedtime")) {
        await strap.buzz(600).catch(() => undefined);
        set({ nudge: { kind: "bedtime", text: `Head to bed by ${new Date(bed.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} to get all the sleep you need.` } });
        void api("/api/log", { method: "POST", json: { type: "bedtime.nudge", data: { at: bed.at } } });
      }
    } catch {
      /* automations are best-effort */
    }
  }, [strap]);

  const sync = useCallback(async () => {
    if (syncing.current || !strap.connected) return;
    syncing.current = true;
    abort.current = new AbortController();
    const progress: SyncProgress = { frames: 0, batches: 0, newestTs: null, startedAt: Date.now() };
    set({ status: "syncing", progress, error: null });
    try {
      const companion = companionRef.current;
      // in companion mode the strap re-sends what we already have: skip it
      const { latestTs } = await api<{ latestTs: number | null }>("/api/sync/state");
      const fresh = (f: Uint8Array) => {
        if (!companion || !latestTs || f[4] !== 47 || f.length < 15) return true;
        return new DataView(f.buffer, f.byteOffset).getUint32(11, true) > latestTs;
      };
      const res = await strap.syncHistory(async (all, newest) => {
        const frames = all.filter(fresh);
        for (let i = 0; i < frames.length; i += 4000) {
          await api("/api/ingest", { method: "POST", json: { device: deviceId(), frames: frames.slice(i, i + 4000).map(b64) } });
        }
        progress.frames += frames.length;
        progress.batches++;
        progress.newestTs = newest;
        set({ progress: { ...progress } });
      }, { signal: abort.current.signal, ack: !companion });
      await api("/api/sync/complete", { method: "POST", json: { device: deviceId(), records: res.frames } });
      await api("/api/device", { method: "POST", json: { id: deviceId(), name: strap.name, firmware: strap.firmware || undefined, battery: strap.battery ?? undefined } });
      set({
        status: "connected",
        progress: null,
        lastSync: { at: Date.now() / 1000, frames: res.frames },
        notice: res.stalled ? "Companion mode: the strap is holding older data for the WHOOP app, so it re-sent the same batch. Let the WHOOP app sync, then sync here again — or turn companion mode off to read everything (the WHOOP app then won't get that data)." : null,
      });
      dataChanged();
      void automations();
    } catch (e) {
      set({ status: strap.connected ? "connected" : "error", progress: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      syncing.current = false;
    }
  }, [strap, automations]);

  // strap events: battery, wrist, double-tap
  useEffect(() => {
    const onEvent = (ev: Event) => {
      const e = (ev as CustomEvent<StrapEvent>).detail;
      if (e.id === EventNumber.BATTERY_LEVEL) {
        const b = batteryEvent(e);
        if (b) set({ battery: b.pct });
      }
      if (e.id === EventNumber.DOUBLE_TAP) window.dispatchEvent(new Event("ow:doubletap"));
    };
    const onBeat = (ev: Event) => {
      const b = (ev as CustomEvent<LiveBeat>).detail;
      setS((x) => ({ ...x, live: b, beats: [...x.beats.filter((y) => b.t - y.t < 5 * 60_000), b] }));
    };
    const onDisc = () => set({ status: "idle", live: null });
    strap.addEventListener("strap-event", onEvent);
    strap.addEventListener("beat", onBeat);
    strap.addEventListener("disconnected", onDisc);
    return () => {
      strap.removeEventListener("strap-event", onEvent);
      strap.removeEventListener("beat", onBeat);
      strap.removeEventListener("disconnected", onDisc);
    };
  }, [strap]);

  // keep syncing every 10 minutes while connected
  useEffect(() => {
    if (!s.keepSynced || (s.status !== "connected" && s.status !== "syncing")) return;
    const t = window.setInterval(() => void sync(), 10 * 60_000);
    return () => clearInterval(t);
  }, [s.keepSynced, s.status, sync]);

  // reconnect silently to a previously paired strap
  useEffect(() => {
    if (!bluetoothAvailable()) return;
    strap
      .restore()
      .then((ok) => ok && set({ status: "connected", name: strap.name, serial: strap.serial, battery: strap.battery, firmware: strap.firmware }))
      .catch(() => undefined);
  }, [strap]);

  const value: DeviceApi = {
    ...s,
    strap,
    async connect() {
      set({ status: "connecting", error: null });
      try {
        await strap.pick();
        set({ status: "connected", name: strap.name, serial: strap.serial, battery: strap.battery, firmware: strap.firmware });
        void sync();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ status: strap.connected ? "connected" : "idle", error: /cancel/i.test(msg) ? null : msg });
      }
    },
    disconnect() {
      abort.current?.abort();
      strap.disconnect();
      set({ status: "idle", live: null });
    },
    sync,
    cancelSync: () => abort.current?.abort(),
    setKeepSynced(v) {
      localStorage.setItem("ow:keepSynced", v ? "1" : "0");
      set({ keepSynced: v });
    },
    setCompanion(v) {
      localStorage.setItem("ow:companion", v ? "1" : "0");
      set({ companion: v });
    },
    startLive: () => strap.startLive(),
    stopLive: () => strap.stopLive(),
    dismissNudge: () => set({ nudge: null }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
