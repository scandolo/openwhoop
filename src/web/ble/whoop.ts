// WHOOP 4.0 over Web Bluetooth (Chrome/Edge on desktop and Android).
// Protocol notes: docs/protocol.md.
import { CHAR_CMD_FROM_STRAP, CHAR_CMD_TO_STRAP, CHAR_DATA_FROM_STRAP, CHAR_EVENTS_FROM_STRAP, Command, PacketType, WHOOP_SERVICE } from "../../protocol/constants.ts";
import { commands, HAPTIC } from "../../protocol/commands.ts";
import { FrameAssembler, type Packet } from "../../protocol/packet.ts";
import { decodeMetadata } from "../../protocol/history.ts";
import { batteryFromResponse, clockFromResponse, decodeEvent, decodeRealtime, helloFromResponse, versionFromResponse, type StrapEvent } from "../../protocol/device.ts";

export const bluetoothAvailable = () => typeof navigator !== "undefined" && "bluetooth" in navigator;

export interface LiveBeat {
  t: number; // ms epoch
  hr: number;
  rr: number[];
}

type Waiter = { cmd: number; seq: number; resolve: (p: Packet) => void; reject: (e: Error) => void; timer: number };

export class Whoop extends EventTarget {
  device: BluetoothDevice | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private asm = { cmd: new FrameAssembler(), evt: new FrameAssembler(), data: new FrameAssembler() };
  private waiters: Waiter[] = [];
  private dataListener: ((frame: Uint8Array, p: Packet) => void) | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  serial = "";
  firmware = "";
  battery: number | null = null;

  get connected() {
    return !!this.device?.gatt?.connected;
  }
  get name() {
    return this.device?.name ?? "WHOOP";
  }

  /** Shows the browser's device picker (must run from a user gesture). */
  async pick() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [WHOOP_SERVICE] }, { namePrefix: "WHOOP" }],
      optionalServices: [WHOOP_SERVICE, "heart_rate", "battery_service"],
    });
    this.device.addEventListener("gattserverdisconnected", () => this.dispatchEvent(new Event("disconnected")));
    await this.connect();
  }

  /** Re-attach to a strap this site was allowed before (no picker), where supported. */
  async restore(): Promise<boolean> {
    const nav = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    if (!nav.getDevices) return false;
    const known = (await nav.getDevices()).find((d) => d.name?.startsWith("WHOOP"));
    if (!known) return false;
    this.device = known;
    this.device.addEventListener("gattserverdisconnected", () => this.dispatchEvent(new Event("disconnected")));
    await this.connect();
    return true;
  }

  async connect() {
    if (!this.device?.gatt) throw new Error("No strap selected");
    const gatt = await this.device.gatt.connect();
    const svc = await gatt.getPrimaryService(WHOOP_SERVICE);
    this.tx = await svc.getCharacteristic(CHAR_CMD_TO_STRAP);
    const sub = async (uuid: string, asm: FrameAssembler, on: (frame: Uint8Array, p: Packet) => void) => {
      const ch = await svc.getCharacteristic(uuid);
      ch.addEventListener("characteristicvaluechanged", () => {
        const v = ch.value!;
        for (const { frame, packet } of asm.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)))) on(frame, packet);
      });
      await ch.startNotifications();
    };
    this.asm = { cmd: new FrameAssembler(), evt: new FrameAssembler(), data: new FrameAssembler() };
    await sub(CHAR_CMD_FROM_STRAP, this.asm.cmd, (_f, p) => this.onResponse(p));
    await sub(CHAR_EVENTS_FROM_STRAP, this.asm.evt, (_f, p) => this.onEventPacket(p));
    await sub(CHAR_DATA_FROM_STRAP, this.asm.data, (f, p) => this.onData(f, p));
    // a confirmed write triggers "just works" bonding; notifications stay quiet until bonded
    const bat = await this.request(commands.battery(), Command.GET_BATTERY_LEVEL, 15000);
    this.battery = batteryFromResponse(bat);
    const hello = helloFromResponse(await this.request(commands.hello(), Command.GET_HELLO_HARVARD));
    if (hello) this.serial = hello.serial;
    try {
      const v = versionFromResponse(await this.request(commands.version(), Command.REPORT_VERSION_INFO));
      if (v) this.firmware = v.harvard;
    } catch {
      /* optional */
    }
    this.dispatchEvent(new Event("connected"));
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }

  // ── commands ─────────────────────────────────────────────────────────
  private write(frame: Uint8Array) {
    // writes are serialised; each one waits for the GATT write response
    const next = this.writeChain.catch(() => undefined).then(() => this.tx!.writeValueWithResponse(frame as Uint8Array<ArrayBuffer>));
    this.writeChain = next;
    return next;
  }

  request({ seq, frame }: { seq: number; frame: Uint8Array }, cmd: number, timeout = 6000): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { cmd, seq, resolve, reject, timer: 0 };
      w.timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`strap did not answer command ${cmd}`));
      }, timeout);
      this.waiters.push(w);
      this.write(frame).catch((e) => {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(e);
      });
    });
  }

  send(c: { frame: Uint8Array }) {
    return this.write(c.frame);
  }

  private onResponse(p: Packet) {
    if (p.type !== PacketType.COMMAND_RESPONSE) return;
    const status = p.data[1];
    if (status === 2) return; // pending: the real reply follows
    const w = this.waiters.find((x) => x.cmd === p.cmd && x.seq === p.data[0]) ?? this.waiters.find((x) => x.cmd === p.cmd);
    if (!w) return;
    this.waiters = this.waiters.filter((x) => x !== w);
    clearTimeout(w.timer);
    w.resolve(p);
  }

  private onEventPacket(p: Packet) {
    const e = decodeEvent(p);
    if (e) this.dispatchEvent(new CustomEvent<StrapEvent>("strap-event", { detail: e }));
  }

  private onData(frame: Uint8Array, p: Packet) {
    if (p.type === PacketType.REALTIME_DATA) {
      const r = decodeRealtime(p);
      if (r && r.hr > 0) this.dispatchEvent(new CustomEvent<LiveBeat>("beat", { detail: { t: Date.now(), hr: r.hr, rr: r.rr } }));
      return;
    }
    this.dataListener?.(frame, p);
  }

  async refreshBattery() {
    this.battery = batteryFromResponse(await this.request(commands.battery(), Command.GET_BATTERY_LEVEL));
    return this.battery;
  }

  /** Keep the strap clock right: records are stamped with it. */
  async syncClock() {
    const t = clockFromResponse(await this.request(commands.getClock(), Command.GET_CLOCK));
    const nowS = Math.floor(Date.now() / 1000);
    if (t === null || Math.abs(t - nowS) > 5) await this.request(commands.setClock(nowS), Command.SET_CLOCK).catch(() => undefined);
  }

  // ── history ──────────────────────────────────────────────────────────
  /**
   * Download stored history. `onBatch` must persist the frames (upload them)
   * before resolving: only then is the batch acknowledged, which lets the
   * strap free that flash. A failed upload leaves the data on the strap.
   */
  async syncHistory(
    onBatch: (frames: Uint8Array[], newestTs: number | null) => Promise<void>,
    opts: { signal?: AbortSignal; ack?: boolean } = {},
  ): Promise<{ frames: number; batches: number; stalled: boolean }> {
    const { signal, ack: shouldAck = true } = opts;
    let stalled = false;
    const seenEnds = new Set<string>();
    await this.syncClock().catch(() => undefined);
    let frames: Uint8Array[] = [];
    let newest: number | null = null;
    let total = 0, batches = 0;
    let lastActivity = Date.now();
    let done!: () => void;
    let fail!: (e: Error) => void;
    const finished = new Promise<void>((res, rej) => {
      done = res;
      fail = rej;
    });
    let chain = Promise.resolve();
    this.dataListener = (frame, p) => {
      lastActivity = Date.now();
      if (p.type === PacketType.HISTORICAL_DATA || p.type === PacketType.EVENT) {
        frames.push(frame);
        if (p.type === PacketType.HISTORICAL_DATA && p.data.length >= 8) newest = new DataView(p.data.buffer, p.data.byteOffset).getUint32(4, true);
        return;
      }
      if (p.type !== PacketType.METADATA) return;
      const m = decodeMetadata(p);
      if (m.kind === "end" && m.ack) {
        const batch = frames;
        frames = [];
        const ack = m.ack;
        const key = Array.from(ack).join(",");
        if (!shouldAck && seenEnds.has(key)) {
          // companion mode: the strap re-sends a batch it was never told it could free
          stalled = true;
          chain.then(() => done());
          return;
        }
        seenEnds.add(key);
        chain = chain
          .then(() => onBatch(batch, newest))
          .then(() => (shouldAck ? this.send(commands.ackHistory(ack)) : undefined))
          .then(() => {
            total += batch.length;
            batches++;
          })
          .catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
      } else if (m.kind === "complete") {
        chain.then(() => done());
      }
    };
    const idle = window.setInterval(() => {
      if (signal?.aborted) fail(new Error("cancelled"));
      else if (Date.now() - lastActivity > (shouldAck ? 30000 : 10000)) chain.then(() => done()); // strap went quiet
    }, 1000);
    try {
      await this.request(commands.sendHistory(), Command.SEND_HISTORICAL_DATA).catch(() => undefined);
      await finished;
    } finally {
      clearInterval(idle);
      this.dataListener = null;
      if (signal?.aborted) await this.send(commands.abortHistory()).catch(() => undefined);
    }
    return { frames: total, batches, stalled };
  }

  // ── live heart rate (standard HR profile: HR + RR) ───────────────────
  async startLive() {
    await this.request(commands.genericHrProfile(true), Command.TOGGLE_GENERIC_HR_PROFILE).catch(() => undefined);
    try {
      const svc = await this.device!.gatt!.getPrimaryService("heart_rate");
      const ch = await svc.getCharacteristic("heart_rate_measurement");
      ch.addEventListener("characteristicvaluechanged", () => {
        const v = ch.value!;
        const flags = v.getUint8(0);
        let o = 1;
        const hr = flags & 1 ? v.getUint16(o, true) : v.getUint8(o);
        o += flags & 1 ? 2 : 1;
        if (flags & 8) o += 2; // energy expended
        const rr: number[] = [];
        if (flags & 16) for (; o + 1 < v.byteLength; o += 2) rr.push(Math.round((v.getUint16(o, true) / 1024) * 1000));
        this.dispatchEvent(new CustomEvent<LiveBeat>("beat", { detail: { t: Date.now(), hr, rr } }));
      });
      await ch.startNotifications();
    } catch {
      // fall back to WHOOP's own realtime stream
      await this.request(commands.realtimeHr(true), Command.TOGGLE_REALTIME_HR).catch(() => undefined);
    }
  }

  async stopLive() {
    await this.send(commands.realtimeHr(false)).catch(() => undefined);
    await this.send(commands.genericHrProfile(false)).catch(() => undefined);
  }

  // ── haptics & alarm ──────────────────────────────────────────────────
  /** A buzz. Short taps stop the pattern after `ms`. */
  async buzz(ms = 0, pattern: number = HAPTIC.ALARM, loops = 1) {
    await this.send(commands.haptics(pattern, loops));
    if (ms > 0) window.setTimeout(() => void this.send(commands.stopHaptics()).catch(() => undefined), ms);
  }

  stopBuzz() {
    return this.send(commands.stopHaptics());
  }

  wakeUp() {
    return this.send(commands.runAlarm());
  }

  /** Program the strap's own alarm (fires with no phone or laptop around). */
  async setStrapAlarm(unix: number) {
    await this.request(commands.setAlarm(unix), Command.SET_ALARM_TIME);
  }

  async clearStrapAlarm() {
    await this.request(commands.disableAlarm(), Command.DISABLE_ALARM).catch(() => undefined);
  }
}
