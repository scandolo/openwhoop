// Builders for commands sent to the strap (WHOOP 4.0). Payloads follow
// captures of the official app where available — see docs/protocol.md.
import { Command, PacketType } from "./constants.ts";
import { encodePacket } from "./packet.ts";

let seq = 0;
/** The strap echoes seq in its response, so we roll it to match replies. */
export function command(cmd: number, data: ArrayLike<number> = [0x00], s?: number): { seq: number; frame: Uint8Array } {
  seq = s ?? (seq + 1) & 0xff;
  return { seq, frame: encodePacket({ type: PacketType.COMMAND, seq, cmd, data: Uint8Array.from(data) }) };
}

const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** Haptic presets (0-6). 2 is the graduated buzz the official app uses for alarms. */
export const HAPTIC = { ALARM: 2 } as const;

export const commands = {
  hello: () => command(Command.GET_HELLO_HARVARD),
  version: () => command(Command.REPORT_VERSION_INFO),
  battery: () => command(Command.GET_BATTERY_LEVEL),
  getClock: () => command(Command.GET_CLOCK),
  /** 9-byte body; shorter bodies are acknowledged but not latched. */
  setClock: (unix: number) => command(Command.SET_CLOCK, [...u32le(unix), 0, 0, 0, 0, 0]),
  realtimeHr: (on: boolean) => command(Command.TOGGLE_REALTIME_HR, [on ? 1 : 0]),
  genericHrProfile: (on: boolean) => command(Command.TOGGLE_GENERIC_HR_PROFILE, [on ? 1 : 0]),
  sendHistory: () => command(Command.SEND_HISTORICAL_DATA),
  /** Echo the 8 bytes from HISTORY_END verbatim, only after the batch is stored. */
  ackHistory: (endBytes: Uint8Array) => command(Command.HISTORICAL_DATA_RESULT, [1, ...endBytes.slice(0, 8)]),
  abortHistory: () => command(Command.ABORT_HISTORICAL_TRANSMITS, []),
  dataRange: () => command(Command.GET_DATA_RANGE),
  haptics: (pattern: number = HAPTIC.ALARM, loops = 1) => command(Command.RUN_HAPTICS_PATTERN, [pattern, loops, 0, 0, 0]),
  stopHaptics: () => command(Command.STOP_HAPTICS),
  runAlarm: () => command(Command.RUN_ALARM, [1]),
  /** Strap-driven alarm (fires even if nothing is connected). */
  setAlarm: (unix: number) => command(Command.SET_ALARM_TIME, [1, ...u32le(unix), 0, 0, 0, 0]),
  getAlarm: () => command(Command.GET_ALARM_TIME, [1]),
  disableAlarm: () => command(Command.DISABLE_ALARM, [1]),
};
