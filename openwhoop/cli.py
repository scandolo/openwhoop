"""Click CLI — scan, download, detect-events, calculate-*."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time

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
@click.option("--device", "-d", default=None, help="Device name (default: WHOOP_DEVICE_NAME from .env).")
@click.option("--db", default=None, help="Database URL (default: from .env).")
@click.option("--no-high-freq", is_flag=True, help="Disable high-frequency sync.")
@click.option(
    "--destructive", is_flag=True,
    help="ACK the trim pointer after download, deleting data from the strap. "
         "By default, data is preserved so the official Whoop app can also "
         "sync it to the cloud (companion mode).",
)
def download(device: str | None, db: str | None, no_high_freq: bool, destructive: bool) -> None:
    """Download history from Whoop to database."""
    from .ble.scanner import find_device_by_name
    from .ble.client import WhoopClient
    from .db.database import DatabaseHandler
    from .config import WHOOP_DEVICE_NAME

    device = device or WHOOP_DEVICE_NAME
    if not device:
        click.echo("No device specified. Use -d or set WHOOP_DEVICE_NAME in .env.", err=True)
        sys.exit(1)

    async def _download() -> None:
        click.echo(f"Searching for '{device}'...")
        ble_device = await find_device_by_name(device)
        if not ble_device:
            click.echo(f"Device '{device}' not found.", err=True)
            sys.exit(1)

        client = WhoopClient(ble_device)
        await client.connect()

        peek = not destructive
        mode = "companion (strap data preserved)" if peek else "destructive (strap data will be deleted)"
        click.echo(f"Connected. Downloading history in {mode} mode...")
        from rich.console import Console
        from rich.live import Live

        console = Console()
        count = 0
        start = time.monotonic()

        def on_reading(r):
            nonlocal count
            count += 1
            elapsed = time.monotonic() - start
            rate = count / elapsed if elapsed > 0 else 0
            live.update(f"  ↓ {count} readings  ({rate:.0f}/sec, {elapsed:.0f}s)")

        with Live("  ↓ 0 readings", refresh_per_second=4, console=console) as live:
            logging.disable(logging.INFO)
            readings = await client.sync_history(
                high_freq=not no_high_freq, peek=peek, on_reading=on_reading
            )
            logging.disable(logging.NOTSET)
        await client.disconnect()

        handler = DatabaseHandler(db)
        result = handler.upsert_readings(readings)
        inserted = result["inserted"]
        updated = result["updated"]
        skipped = result["skipped"]
        latest = result["latest_ts"]

        click.echo(f"Done: {len(readings)} received, {inserted} new, {updated} updated, {skipped} unchanged.")
        if latest:
            from datetime import datetime, timezone
            ts_str = datetime.fromtimestamp(latest, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            click.echo(f"Latest reading: {ts_str}")
        if peek:
            click.echo("Strap data preserved. Open Whoop app to sync same data to cloud.")

    asyncio.run(_download())


@cli.command()
@click.option("--device", "-d", default=None, help="Device name (default: WHOOP_DEVICE_NAME from .env).")
def info(device: str | None) -> None:
    """Show device info (battery, clock, version)."""
    from .ble.scanner import find_device_by_name
    from .ble.client import WhoopClient
    from .config import WHOOP_DEVICE_NAME

    device = device or WHOOP_DEVICE_NAME
    if not device:
        click.echo("No device specified. Use -d or set WHOOP_DEVICE_NAME in .env.", err=True)
        sys.exit(1)

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
    result = handler.upsert_readings(readings)
    click.echo(
        f"Done: {result['inserted']} new, {result['updated']} updated, "
        f"{result['skipped']} unchanged."
    )


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


# ── Daily analysis commands ─────────────────────────────────────────


def _compute_daily_scores(handler, days, resting_hr, max_hr):
    """Compute and store daily scores for the given day boundaries.

    Args:
        handler: DatabaseHandler instance.
        days: list of (date_str, start_ts, end_ts) from get_day_boundaries.
        resting_hr: Resting heart rate for strain calculation.
        max_hr: Max heart rate for strain calculation.

    Returns:
        Number of days processed.
    """
    from .algos.stress import baevsky_stress_index
    from .algos.spo2 import calculate_spo2 as calc_spo2
    from .algos.temperature import avg_skin_temp
    from .algos.strain import strain_score
    from .algos.hrv import normalized_hrv
    from .db.schema import DailyScoreRecord

    computed = 0
    for date_str, start_ts, end_ts in days:
        records = handler.get_hr_range(start_ts, end_ts)
        if not records:
            continue

        all_rr: list[int] = []
        reds: list[int] = []
        irs: list[int] = []
        skin_temps: list[int] = []
        hr_samples: list[int] = []

        for r in records:
            all_rr.extend(r.get_rr_list())
            if r.spo2_red and r.spo2_red > 0:
                reds.append(r.spo2_red)
            if r.spo2_ir and r.spo2_ir > 0:
                irs.append(r.spo2_ir)
            if r.skin_temp_raw and r.skin_temp_raw > 0:
                skin_temps.append(r.skin_temp_raw)
            if r.bpm and r.bpm > 0:
                hr_samples.append(r.bpm)

        stress = baevsky_stress_index(all_rr)
        spo2 = calc_spo2(reds, irs)
        skin_temp = avg_skin_temp(skin_temps)
        strain = strain_score(hr_samples, resting_hr=resting_hr, max_hr=max_hr)
        hrv = normalized_hrv(all_rr) if len(all_rr) >= 2 else None
        rhr = float(min(hr_samples)) if hr_samples else None

        score = DailyScoreRecord(
            date=date_str,
            stress=stress,
            strain=strain,
            hrv=hrv,
            rhr=rhr,
            spo2=spo2,
            skin_temp=skin_temp,
        )
        handler.upsert_daily_score(score)
        computed += 1

        # Print per-day summary line
        parts = [f"  {date_str}  {len(records):>6} readings"]
        if strain is not None:
            parts.append(f"strain={strain:.1f}")
        if hrv is not None:
            parts.append(f"hrv={hrv:.0f}")
        if rhr is not None:
            parts.append(f"rhr={rhr:.0f}")
        if spo2 is not None:
            parts.append(f"spo2={spo2:.1f}%")
        if skin_temp is not None:
            parts.append(f"temp={skin_temp:.1f}C")
        if stress is not None:
            parts.append(f"stress={stress:.2f}")

        skipped = []
        if stress is None and len(all_rr) < 120:
            skipped.append(f"stress(<120 RR, got {len(all_rr)})")
        if strain is None and len(hr_samples) < 600:
            skipped.append(f"strain(<600 HR, got {len(hr_samples)})")

        click.echo(" | ".join(parts))
        if skipped:
            click.echo(f"    [skipped: {', '.join(skipped)}]")

    return computed


@cli.command("sync")
@click.option("--device", "-d", default=None, help="Device name (default: WHOOP_DEVICE_NAME from .env).")
@click.option("--db", default=None, help="Database URL (default: from .env).")
@click.option("--tz", default=None, help="Timezone (IANA, e.g. America/New_York).")
@click.option("--resting-hr", default=60, help="Resting heart rate for strain.")
@click.option("--max-hr", default=200, help="Max heart rate for strain.")
@click.option("--no-high-freq", is_flag=True, help="Disable high-frequency sync.")
@click.option("--peek/--destructive", default=True,
              help="Peek preserves strap data (default). Destructive trims it.")
def sync(device: str | None, db: str | None, tz: str | None,
         resting_hr: int, max_hr: int, no_high_freq: bool, peek: bool) -> None:
    """Connect, download, process, and summarize — the all-in-one workflow."""
    from .ble.scanner import find_device_by_name
    from .ble.client import WhoopClient
    from .db.database import DatabaseHandler
    from .config import TIMEZONE, WHOOP_DEVICE_NAME

    device = device or WHOOP_DEVICE_NAME
    if not device:
        click.echo("No device specified. Use -d or set WHOOP_DEVICE_NAME in .env.", err=True)
        sys.exit(1)

    tz_name = tz or TIMEZONE

    async def _sync() -> None:
        # ── Connect & download ───────────────────────────────────────
        click.echo(f"Searching for '{device}'...")
        ble_device = await find_device_by_name(device)
        if not ble_device:
            click.echo(f"Device '{device}' not found.", err=True)
            sys.exit(1)

        client = WhoopClient(ble_device)
        await client.connect()

        mode = "companion" if peek else "destructive"
        click.echo(f"Connected. Downloading history ({mode} mode)...")
        from rich.console import Console
        from rich.live import Live

        console = Console()
        count = 0
        start = time.monotonic()

        def on_reading(r):
            nonlocal count
            count += 1
            elapsed = time.monotonic() - start
            rate = count / elapsed if elapsed > 0 else 0
            live.update(f"  ↓ {count} readings  ({rate:.0f}/sec, {elapsed:.0f}s)")

        with Live("  ↓ 0 readings", refresh_per_second=4, console=console) as live:
            logging.disable(logging.INFO)
            readings = await client.sync_history(
                high_freq=not no_high_freq, peek=peek, on_reading=on_reading
            )
            logging.disable(logging.NOTSET)

        # ── Real-time HR snapshot ────────────────────────────────────
        try:
            current_hr = await asyncio.wait_for(
                client.read_current_hr(timeout=5.0), timeout=8.0
            )
        except (asyncio.TimeoutError, Exception):
            current_hr = None
        await client.disconnect()

        # ── Store readings ───────────────────────────────────────────
        handler = DatabaseHandler(db)
        result = handler.upsert_readings(readings)
        click.echo(
            f"Done: {len(readings)} received, {result['inserted']} new, "
            f"{result['updated']} updated."
        )

        if current_hr:
            click.echo(f"\nCurrent HR: {current_hr} bpm")

        if not readings:
            click.echo("No readings to process.")
            return

        # ── Daily processing ─────────────────────────────────────────
        min_ts = min(r.unix_ts for r in readings)
        max_ts = max(r.unix_ts for r in readings)
        all_days = handler.get_day_boundaries(tz_name)
        affected = [(d, s, e) for d, s, e in all_days if s <= max_ts and e >= min_ts]

        if affected:
            click.echo(f"\nDaily summary ({len(affected)} day(s), tz={tz_name}):")
            _compute_daily_scores(handler, affected, resting_hr, max_hr)
        else:
            click.echo("No complete days to summarize.")

    asyncio.run(_sync())


@cli.command("daily-summary")
@click.option("--db", default=None, help="Database URL.")
@click.option("--date", "target_date", default=None, help="Process a single date (YYYY-MM-DD).")
@click.option("--tz", default=None, help="Timezone (IANA, e.g. America/New_York).")
@click.option("--resting-hr", default=60, help="Resting heart rate for strain.")
@click.option("--max-hr", default=200, help="Max heart rate for strain.")
def daily_summary(db: str | None, target_date: str | None, tz: str | None,
                  resting_hr: int, max_hr: int) -> None:
    """Compute daily metrics from stored data and save to daily_scores."""
    from .db.database import DatabaseHandler
    from .config import TIMEZONE

    tz_name = tz or TIMEZONE
    handler = DatabaseHandler(db)
    days = handler.get_day_boundaries(tz_name)

    if not days:
        click.echo("No data in database. Run 'sync' or 'download' first.")
        return

    if target_date:
        days = [(d, s, e) for d, s, e in days if d == target_date]
        if not days:
            click.echo(f"No data for {target_date}.")
            return

    click.echo(f"Processing {len(days)} day(s) (tz={tz_name}):")
    computed = _compute_daily_scores(handler, days, resting_hr, max_hr)
    click.echo(f"\n{computed} day(s) saved to daily_scores.")


@cli.command("show-daily")
@click.option("--db", default=None, help="Database URL.")
@click.option("--date", "target_date", default=None, help="Show a single date.")
@click.option("--last", "last_n", default=None, type=int, help="Show last N days.")
def show_daily(db: str | None, target_date: str | None, last_n: int | None) -> None:
    """Display stored daily scores."""
    from .db.database import DatabaseHandler

    handler = DatabaseHandler(db)
    if target_date:
        scores = handler.get_daily_scores(start_date=target_date, end_date=target_date)
    else:
        scores = handler.get_daily_scores()

    if last_n:
        scores = scores[-last_n:]

    if not scores:
        click.echo("No daily scores stored. Run 'sync' or 'daily-summary' first.")
        return

    for s in scores:
        parts = [s.date]
        for col, fmt in [
            ("recovery", ".0f"), ("strain", ".1f"), ("sleep_score", ".0f"),
            ("hrv", ".0f"), ("rhr", ".0f"), ("spo2", ".1f"),
            ("skin_temp", ".1f"), ("stress", ".2f"), ("resp_rate", ".1f"),
        ]:
            val = getattr(s, col)
            if val is not None:
                parts.append(f"{col}={val:{fmt}}")
        click.echo("  " + "  ".join(parts))
