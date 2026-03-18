"""Click CLI — scan, download, detect-events, calculate-*."""

from __future__ import annotations

import asyncio
import json
import logging
import sys

import click

from . import __version__


@click.group()
@click.version_option(__version__)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def cli(verbose: bool) -> None:
    """OpenWhoop — Open-source Whoop 4.0 clone."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)s: %(message)s")


# ── BLE commands ─────────────────────────────────────────────────────


@cli.command()
@click.option("--timeout", default=10.0, help="Scan timeout in seconds.")
def scan(timeout: float) -> None:
    """Scan for Whoop devices via BLE."""
    from .ble.scanner import scan_for_whoop

    async def _scan() -> None:
        devices = await scan_for_whoop(timeout=timeout)
        if not devices:
            click.echo("No Whoop devices found.")
            return
        for d in devices:
            click.echo(f"  {d.name}  ({d.address})")

    asyncio.run(_scan())


@cli.command()
@click.option("--device", "-d", required=True, help="Device name (e.g. 'WHOOP XXXXXXXXX').")
@click.option("--db", default=None, help="Database URL (default: from .env).")
@click.option("--no-high-freq", is_flag=True, help="Disable high-frequency sync.")
def download(device: str, db: str | None, no_high_freq: bool) -> None:
    """Download history from Whoop to database."""
    from .ble.scanner import find_device_by_name
    from .ble.client import WhoopClient
    from .db.database import DatabaseHandler

    async def _download() -> None:
        click.echo(f"Searching for '{device}'...")
        ble_device = await find_device_by_name(device)
        if not ble_device:
            click.echo(f"Device '{device}' not found.", err=True)
            sys.exit(1)

        client = WhoopClient(ble_device)
        await client.connect()

        click.echo("Connected. Downloading history...")
        count = 0

        def on_reading(r):
            nonlocal count
            count += 1
            if count % 100 == 0:
                click.echo(f"  {count} readings...")

        readings = await client.sync_history(
            high_freq=not no_high_freq, on_reading=on_reading
        )
        await client.disconnect()

        handler = DatabaseHandler(db)
        inserted = handler.upsert_readings(readings)
        click.echo(f"Done: {len(readings)} readings downloaded, {inserted} new rows inserted.")

    asyncio.run(_download())


@cli.command()
@click.option("--device", "-d", required=True, help="Device name.")
def info(device: str) -> None:
    """Show device info (battery, clock, version)."""
    from .ble.scanner import find_device_by_name
    from .ble.client import WhoopClient

    async def _info() -> None:
        ble_device = await find_device_by_name(device)
        if not ble_device:
            click.echo(f"Device '{device}' not found.", err=True)
            sys.exit(1)

        client = WhoopClient(ble_device)
        await client.connect()
        click.echo(f"Battery: {await client.get_battery():.1f}%")
        click.echo(f"Version: {await client.get_version()}")
        await client.disconnect()

    asyncio.run(_info())


# ── Offline analysis commands ────────────────────────────────────────


@cli.command("import")
@click.argument("file", type=click.Path(exists=True))
@click.option("--db", default=None, help="Database URL.")
def import_dump(file: str, db: str | None) -> None:
    """Import a raw binary dump file (whoomp format) into the database."""
    from .protocol.decoder import parse_binary_dump
    from .db.database import DatabaseHandler

    with open(file, "rb") as f:
        data = f.read()

    readings = parse_binary_dump(data)
    click.echo(f"Parsed {len(readings)} readings from {file}")

    handler = DatabaseHandler(db)
    inserted = handler.upsert_readings(readings)
    click.echo(f"Inserted {inserted} new rows.")


@cli.command("detect-events")
@click.option("--db", default=None, help="Database URL.")
def detect_events(db: str | None) -> None:
    """Detect sleep and activity periods from stored data."""
    from .db.database import DatabaseHandler
    from .db.schema import SleepCycleRecord
    from .models import HistoryReading, SensorData
    from .algos.sleep import detect_sleep_periods, sleep_hr_stats, sleep_score

    handler = DatabaseHandler(db)
    records = handler.get_all_hr()

    if not records:
        click.echo("No data in database. Run 'download' or 'import' first.")
        return

    # Convert DB records to HistoryReading objects
    readings = []
    for r in records:
        sensor = None
        if r.gravity_x is not None:
            sensor = SensorData(
                gravity_x=r.gravity_x, gravity_y=r.gravity_y, gravity_z=r.gravity_z,
                skin_contact=1 if r.skin_contact else 0,
                spo2_red=r.spo2_red or 0, spo2_ir=r.spo2_ir or 0,
                skin_temp_raw=r.skin_temp_raw or 0,
            )
        readings.append(HistoryReading(
            unix_ts=r.timestamp, subseconds=r.subseconds or 0,
            heart_rate=r.bpm, rr_intervals=r.get_rr_list(), sensor=sensor,
        ))

    cycles = detect_sleep_periods(readings)
    click.echo(f"Detected {len(cycles)} sleep period(s):")
    for i, c in enumerate(cycles, 1):
        stats = sleep_hr_stats(readings, c)
        score = sleep_score(c)
        click.echo(
            f"  #{i}: {c.duration_hours:.1f}h | "
            f"HR {stats['min_bpm']}-{stats['max_bpm']} (avg {stats['avg_bpm']:.0f}) | "
            f"Score: {score:.0f}"
        )
        handler.save_sleep_cycle(SleepCycleRecord(
            start_ts=c.start_ts, end_ts=c.end_ts,
            duration_seconds=c.duration_seconds,
            min_bpm=stats["min_bpm"], max_bpm=stats["max_bpm"],
            avg_bpm=stats["avg_bpm"], avg_hrv=stats.get("avg_hrv"),
            score=score,
        ))


@cli.command("calculate-stress")
@click.option("--db", default=None, help="Database URL.")
def calculate_stress(db: str | None) -> None:
    """Calculate Baevsky Stress Index from stored RR intervals."""
    from .db.database import DatabaseHandler
    from .algos.stress import baevsky_stress_index

    handler = DatabaseHandler(db)
    records = handler.get_all_hr()
    all_rr: list[int] = []
    for r in records:
        all_rr.extend(r.get_rr_list())

    si = baevsky_stress_index(all_rr)
    if si is None:
        click.echo("Insufficient RR data (need 120+ intervals).")
    else:
        click.echo(f"Stress Index: {si:.2f}")


@cli.command("calculate-spo2")
@click.option("--db", default=None, help="Database URL.")
def calculate_spo2(db: str | None) -> None:
    """Calculate SpO2 from stored sensor data."""
    from .db.database import DatabaseHandler
    from .algos.spo2 import calculate_spo2 as calc_spo2

    handler = DatabaseHandler(db)
    records = handler.get_all_hr()
    reds = [r.spo2_red for r in records if r.spo2_red and r.spo2_red > 0]
    irs = [r.spo2_ir for r in records if r.spo2_ir and r.spo2_ir > 0]

    spo2 = calc_spo2(reds, irs)
    if spo2 is None:
        click.echo("Insufficient SpO2 data (need 30+ valid readings).")
    else:
        click.echo(f"SpO2: {spo2:.1f}%")


@cli.command("calculate-skin-temp")
@click.option("--db", default=None, help="Database URL.")
def calculate_skin_temp(db: str | None) -> None:
    """Calculate average skin temperature from stored data."""
    from .db.database import DatabaseHandler
    from .algos.temperature import avg_skin_temp

    handler = DatabaseHandler(db)
    records = handler.get_all_hr()
    raws = [r.skin_temp_raw for r in records if r.skin_temp_raw and r.skin_temp_raw > 0]

    temp = avg_skin_temp(raws)
    if temp is None:
        click.echo("No valid skin temperature data.")
    else:
        click.echo(f"Avg Skin Temp: {temp:.1f} C")


@cli.command("calculate-strain")
@click.option("--db", default=None, help="Database URL.")
@click.option("--resting-hr", default=60, help="Resting heart rate.")
@click.option("--max-hr", default=200, help="Max heart rate.")
def calculate_strain(db: str | None, resting_hr: int, max_hr: int) -> None:
    """Calculate strain (Edwards TRIMP) from stored HR data."""
    from .db.database import DatabaseHandler
    from .algos.strain import strain_score

    handler = DatabaseHandler(db)
    records = handler.get_all_hr()
    hr_samples = [r.bpm for r in records if r.bpm > 0]

    score = strain_score(hr_samples, resting_hr=resting_hr, max_hr=max_hr)
    if score is None:
        click.echo("Insufficient HR data (need 600+ samples / ~10 min).")
    else:
        click.echo(f"Strain: {score:.1f} / 21.0")
