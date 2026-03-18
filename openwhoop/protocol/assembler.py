"""Multi-notification packet assembler.

BLE notifications are limited to ~244 bytes (MTU). A single Whoop packet can
span multiple notifications. This assembler buffers incoming bytes and yields
complete framed packets.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator

from .constants import SOF
from .packet import WhoopPacket


class PacketAssembler:
    """Accumulates BLE notification fragments and yields complete WhoopPackets."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes | bytearray) -> list[WhoopPacket]:
        """Feed raw notification bytes. Returns list of complete packets (0 or more)."""
        self._buffer.extend(data)
        packets: list[WhoopPacket] = []

        while True:
            pkt = self._try_extract()
            if pkt is None:
                break
            packets.append(pkt)

        return packets

    def _try_extract(self) -> WhoopPacket | None:
        """Try to extract one complete packet from the front of the buffer."""
        # Need at least SOF + 2 length bytes + 1 CRC-8 = 4 bytes for header
        if len(self._buffer) < 4:
            return None

        # Find SOF
        sof_idx = self._buffer.find(SOF)
        if sof_idx == -1:
            self._buffer.clear()
            return None
        if sof_idx > 0:
            # Discard garbage before SOF
            del self._buffer[:sof_idx]

        if len(self._buffer) < 4:
            return None

        # Read length field (payload size including CRC-32)
        length = struct.unpack_from("<H", self._buffer, 1)[0]
        # Total frame: SOF(1) + length(2) + CRC-8(1) + payload(length-4) + CRC-32(4) = length + 4
        total = length + 4
        if len(self._buffer) < total:
            return None  # Need more data

        frame = bytes(self._buffer[:total])
        try:
            pkt = WhoopPacket.from_data(frame)
        except ValueError:
            # Bad packet — skip SOF byte and try again
            del self._buffer[:1]
            return self._try_extract()

        del self._buffer[:total]
        return pkt

    def reset(self) -> None:
        """Clear the internal buffer."""
        self._buffer.clear()
