// Builders for commands sent to the strap.
import { Command, PacketType } from "./constants.ts";
import { encodePacket } from "./packet.ts";

let seq = 0;
function cmd(command: number, data: ArrayLike<number> = [0x00]): Uint8Array {
  seq = (seq + 1) & 0xff;
  return encodePacket({ type: PacketType.COMMAND, seq, cmd: command, data: Uint8Array.from(data) });
}

const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

export const commands = {
  hello: () => cmd(Command.GET_HELLO_HARVARD),
  version: () => cmd(Command.REPORT_VERSION_INFO),
  battery: () => cmd(Command.GET_BATTERY_LEVEL),
  getClock: () => cmd(Command.GET_CLOCK),
  setClock: (unix: number) => cmd(Command.SET_CLOCK, [...u32le(unix), 0, 0, 0, 0, 0]),
  realtimeHr: (on: boolean) => cmd(Command.TOGGLE_REALTIME_HR, [on ? 1 : 0]),
  genericHrProfile: (on: boolean) => cmd(Command.TOGGLE_GENERIC_HR_PROFILE, [on ? 1 : 0]),
  sendHistory: () => cmd(Command.SEND_HISTORICAL_DATA),
  ackHistory: (trim: number) => cmd(Command.HISTORICAL_DATA_RESULT, [1, ...u32le(trim), 0, 0, 0, 0]),
  enterHighFreqSync: () => cmd(Command.ENTER_HIGH_FREQ_SYNC),
  exitHighFreqSync: () => cmd(Command.EXIT_HIGH_FREQ_SYNC),
  runAlarm: () => cmd(Command.RUN_ALARM),
  stopHaptics: () => cmd(Command.STOP_HAPTICS),
  reboot: () => cmd(Command.REBOOT_STRAP),
};
