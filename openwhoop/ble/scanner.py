"""Scan for Whoop devices via BLE."""

from __future__ import annotations

import asyncio

from bleak import BleakScanner
from bleak.backends.device import BLEDevice

from ..protocol.constants import WHOOP_SERVICE


async def scan_for_whoop(timeout: float = 10.0) -> list[BLEDevice]:
    """Scan for BLE devices advertising the Whoop service UUID."""
    devices = await BleakScanner.discover(
        timeout=timeout,
        service_uuids=[WHOOP_SERVICE],
    )
    return [d for d in devices if d.name and "WHOOP" in d.name.upper()]


async def find_device_by_name(name: str, timeout: float = 10.0) -> BLEDevice | None:
    """Find a specific Whoop device by name."""
    return await BleakScanner.find_device_by_name(name, timeout=timeout)
