"""BLE notification handlers — route incoming packets to the right queues."""

from __future__ import annotations

import asyncio
import logging

from ..protocol.assembler import PacketAssembler
from ..protocol.constants import PacketType, MetadataType
from ..protocol.packet import WhoopPacket

log = logging.getLogger(__name__)


class NotificationRouter:
    """Routes BLE notifications through assemblers into typed queues."""

    def __init__(self) -> None:
        self.cmd_queue: asyncio.Queue[WhoopPacket] = asyncio.Queue()
        self.event_queue: asyncio.Queue[WhoopPacket] = asyncio.Queue()
        self.data_queue: asyncio.Queue[WhoopPacket] = asyncio.Queue()
        self.meta_queue: asyncio.Queue[WhoopPacket] = asyncio.Queue()

        self._cmd_asm = PacketAssembler()
        self._event_asm = PacketAssembler()
        self._data_asm = PacketAssembler()

    def cmd_handler(self, _sender: int, data: bytearray) -> None:
        for pkt in self._cmd_asm.feed(data):
            log.debug("CMD: %r", pkt)
            self.cmd_queue.put_nowait(pkt)

    def event_handler(self, _sender: int, data: bytearray) -> None:
        for pkt in self._event_asm.feed(data):
            log.debug("EVENT: %r", pkt)
            self.event_queue.put_nowait(pkt)

    def data_handler(self, _sender: int, data: bytearray) -> None:
        for pkt in self._data_asm.feed(data):
            if pkt.type == PacketType.METADATA:
                log.debug("META: %r", pkt)
                self.meta_queue.put_nowait(pkt)
            else:
                log.debug("DATA: %r", pkt)
                self.data_queue.put_nowait(pkt)

    @staticmethod
    def memfault_handler(_sender: int, _data: bytearray) -> None:
        pass  # Ignored
