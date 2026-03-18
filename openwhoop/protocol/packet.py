"""WhoopPacket: parse, create, and frame Gen4 BLE packets."""

from __future__ import annotations

import struct

from .constants import SOF, PacketType, CommandNumber, EventNumber, MetadataType
from .crc import crc8, crc32


class WhoopPacket:
    """A single Whoop BLE packet (parsed or to-be-sent)."""

    def __init__(
        self,
        type: PacketType = PacketType.COMMAND,
        seq: int = 0,
        cmd: int = 0,
        data: bytes = b"",
    ):
        self.type = PacketType(type)
        self.seq = seq
        self.cmd = cmd
        self.data = data

    # ── Parsing ──────────────────────────────────────────────────────

    @staticmethod
    def from_data(data: bytes | bytearray) -> WhoopPacket:
        """Parse a framed packet (SOF + length + CRC-8 + payload + CRC-32)."""
        if len(data) < 8:
            raise ValueError(f"packet too short ({len(data)} bytes)")
        if data[0] != SOF:
            raise ValueError(f"invalid SOF: 0x{data[0]:02X}")

        # Header CRC-8 over 2 length bytes
        if crc8(data[1:3]) != data[3]:
            raise ValueError("header CRC-8 mismatch")

        length = struct.unpack_from("<H", data, 1)[0]
        if len(data) < length + 4:
            raise ValueError(
                f"packet truncated: need {length + 4} bytes, got {len(data)}"
            )

        payload = data[4:length]
        expected_crc = struct.unpack_from("<I", data, length)[0]
        if crc32(payload) != expected_crc:
            raise ValueError("payload CRC-32 mismatch")

        return WhoopPacket(
            type=payload[0],
            seq=payload[1],
            cmd=payload[2],
            data=bytes(payload[3:]),
        )

    # ── Serialization ────────────────────────────────────────────────

    def to_payload(self) -> bytes:
        """Return raw payload bytes (type + seq + cmd + data)."""
        return struct.pack("<BBB", int(self.type), self.seq, self.cmd) + self.data

    def framed(self) -> bytes:
        """Return the full framed packet ready to send over BLE."""
        payload = self.to_payload()
        length_bytes = struct.pack("<H", len(payload) + 4)
        header_crc = struct.pack("<B", crc8(length_bytes))
        body_crc = struct.pack("<I", crc32(payload))
        return struct.pack("<B", SOF) + length_bytes + header_crc + payload + body_crc

    # ── Factory methods ──────────────────────────────────────────────

    @staticmethod
    def command(cmd: CommandNumber, data: bytes = b"\x00", seq: int = 10) -> WhoopPacket:
        return WhoopPacket(PacketType.COMMAND, seq, int(cmd), data)

    @staticmethod
    def get_hello() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.GET_HELLO_HARVARD)

    @staticmethod
    def get_clock() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.GET_CLOCK)

    @staticmethod
    def set_clock(unix_ts: int) -> WhoopPacket:
        return WhoopPacket.command(
            CommandNumber.SET_CLOCK, struct.pack("<I", unix_ts)
        )

    @staticmethod
    def get_battery() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.GET_BATTERY_LEVEL)

    @staticmethod
    def toggle_realtime_hr(enable: bool = True) -> WhoopPacket:
        return WhoopPacket.command(
            CommandNumber.TOGGLE_REALTIME_HR, b"\x01" if enable else b"\x00"
        )

    @staticmethod
    def send_historical_data() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.SEND_HISTORICAL_DATA)

    @staticmethod
    def history_ack(trim_pointer: int) -> WhoopPacket:
        return WhoopPacket.command(
            CommandNumber.HISTORICAL_DATA_RESULT,
            struct.pack("<BII", 1, trim_pointer, 0),
        )

    @staticmethod
    def enter_high_freq_sync() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.ENTER_HIGH_FREQ_SYNC)

    @staticmethod
    def exit_high_freq_sync() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.EXIT_HIGH_FREQ_SYNC)

    @staticmethod
    def reboot() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.REBOOT_STRAP)

    @staticmethod
    def report_version() -> WhoopPacket:
        return WhoopPacket.command(CommandNumber.REPORT_VERSION_INFO)

    # ── Display ──────────────────────────────────────────────────────

    def __repr__(self) -> str:
        try:
            cmd_name = CommandNumber(self.cmd).name
        except ValueError:
            try:
                cmd_name = EventNumber(self.cmd).name
            except ValueError:
                cmd_name = str(self.cmd)
        return (
            f"WhoopPacket(type={self.type.name}, seq=0x{self.seq:02X}, "
            f"cmd={cmd_name}, data={self.data.hex()})"
        )
