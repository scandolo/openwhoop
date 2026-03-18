"""WhoopClient — high-level async BLE client for Whoop 4.0."""

from __future__ import annotations

import asyncio
import logging
import struct
import time

from bleak import BleakClient
from bleak.backends.device import BLEDevice

from ..models import HistoryReading
from ..protocol.constants import (
    WHOOP_CHAR_CMD_TO_STRAP,
    WHOOP_CHAR_CMD_FROM_STRAP,
    WHOOP_CHAR_EVENTS_FROM_STRAP,
    WHOOP_CHAR_DATA_FROM_STRAP,
    WHOOP_CHAR_MEMFAULT,
    PacketType,
    MetadataType,
)
from ..protocol.decoder import decode_historical
from ..protocol.packet import WhoopPacket
from .handlers import NotificationRouter

log = logging.getLogger(__name__)


class WhoopClient:
    """Manages BLE connection and data sync with a Whoop 4.0 strap."""

    def __init__(self, device: BLEDevice | str) -> None:
        self._address = device
        self._client: BleakClient | None = None
        self._router = NotificationRouter()

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    async def connect(self) -> None:
        """Connect and subscribe to all notification characteristics."""
        self._client = BleakClient(self._address)
        await self._client.connect()
        if not self._client.is_connected:
            raise ConnectionError("Failed to connect to Whoop device")

        log.info("Connected to %s", self._address)

        await self._client.start_notify(WHOOP_CHAR_CMD_FROM_STRAP, self._router.cmd_handler)
        await self._client.start_notify(WHOOP_CHAR_EVENTS_FROM_STRAP, self._router.event_handler)
        await self._client.start_notify(WHOOP_CHAR_DATA_FROM_STRAP, self._router.data_handler)
        await self._client.start_notify(WHOOP_CHAR_MEMFAULT, self._router.memfault_handler)

    async def disconnect(self) -> None:
        if self._client:
            await self._client.disconnect()
            log.info("Disconnected")

    async def _send(self, pkt: WhoopPacket) -> None:
        """Send a framed packet to the strap."""
        assert self._client is not None
        await self._client.write_gatt_char(WHOOP_CHAR_CMD_TO_STRAP, pkt.framed())

    async def _send_recv(self, pkt: WhoopPacket, timeout: float = 5.0) -> WhoopPacket:
        """Send a command and wait for the response."""
        await self._send(pkt)
        return await asyncio.wait_for(self._router.cmd_queue.get(), timeout)

    # ── Commands ─────────────────────────────────────────────────────

    async def hello(self) -> WhoopPacket:
        return await self._send_recv(WhoopPacket.get_hello())

    async def get_clock(self) -> int:
        resp = await self._send_recv(WhoopPacket.get_clock())
        return struct.unpack_from("<I", resp.data, 2)[0]

    async def set_clock(self) -> None:
        await self._send(WhoopPacket.set_clock(int(time.time())))

    async def get_battery(self) -> float:
        resp = await self._send_recv(WhoopPacket.get_battery())
        return struct.unpack_from("<H", resp.data, 2)[0] / 10.0

    async def get_version(self) -> str:
        resp = await self._send_recv(WhoopPacket.report_version())
        vals = struct.unpack_from("<BBBLLLLLLLL", resp.data, 0)
        harvard = f"{vals[3]}.{vals[4]}.{vals[5]}.{vals[6]}"
        boylston = f"{vals[7]}.{vals[8]}.{vals[9]}.{vals[10]}"
        return f"harvard={harvard} boylston={boylston}"

    async def toggle_realtime_hr(self, enable: bool = True) -> None:
        await self._send(WhoopPacket.toggle_realtime_hr(enable))

    async def enter_high_freq_sync(self) -> None:
        await self._send(WhoopPacket.enter_high_freq_sync())

    async def exit_high_freq_sync(self) -> None:
        await self._send(WhoopPacket.exit_high_freq_sync())

    async def reboot(self) -> None:
        await self._send(WhoopPacket.reboot())

    # ── History download ─────────────────────────────────────────────

    async def sync_history(
        self,
        high_freq: bool = True,
        on_reading: callable | None = None,
    ) -> list[HistoryReading]:
        """Download all historical data from the strap.

        Args:
            high_freq: Use high-frequency sync (cmd 96) for ~90x faster download.
            on_reading: Optional callback(reading) for progress.

        Returns:
            List of decoded HistoryReading objects.
        """
        if high_freq:
            await self.enter_high_freq_sync()

        await self._send_recv(WhoopPacket.send_historical_data())

        readings: list[HistoryReading] = []

        while True:
            # Wait for metadata
            meta = await self._router.meta_queue.get()
            meta_type = MetadataType(meta.cmd)

            if meta_type == MetadataType.HISTORY_COMPLETE:
                break

            if meta_type == MetadataType.HISTORY_START:
                # Drain data packets until HISTORY_END
                while True:
                    # Check meta queue for END
                    try:
                        meta = self._router.meta_queue.get_nowait()
                        if MetadataType(meta.cmd) in (
                            MetadataType.HISTORY_END,
                            MetadataType.HISTORY_COMPLETE,
                        ):
                            break
                    except asyncio.QueueEmpty:
                        pass

                    # Process data packets
                    try:
                        pkt = await asyncio.wait_for(
                            self._router.data_queue.get(), timeout=2.0
                        )
                        if pkt.type == PacketType.HISTORICAL_DATA:
                            reading = decode_historical(pkt)
                            readings.append(reading)
                            if on_reading:
                                on_reading(reading)
                    except asyncio.TimeoutError:
                        # Check meta again
                        try:
                            meta = self._router.meta_queue.get_nowait()
                            if MetadataType(meta.cmd) in (
                                MetadataType.HISTORY_END,
                                MetadataType.HISTORY_COMPLETE,
                            ):
                                break
                        except asyncio.QueueEmpty:
                            continue

                if MetadataType(meta.cmd) == MetadataType.HISTORY_COMPLETE:
                    break

                # ACK the batch with trim pointer
                if MetadataType(meta.cmd) == MetadataType.HISTORY_END:
                    trim = struct.unpack_from("<I", meta.data, 10)[0]
                    await self._send(WhoopPacket.history_ack(trim))

        if high_freq:
            await self.exit_high_freq_sync()

        log.info("Downloaded %d readings", len(readings))
        return readings
