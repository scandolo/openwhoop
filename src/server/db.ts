// SQLite storage (node:sqlite, no native dependencies).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,            -- sha256 of the cookie token
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'read',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    firmware TEXT,
    battery REAL,
    last_sync_at INTEGER,
    info TEXT
  );

  -- exact bytes received from the strap, gzip'd, so data can be re-decoded
  CREATE TABLE raw_batches (
    id INTEGER PRIMARY KEY,
    device_id TEXT,
    received_at INTEGER NOT NULL,
    first_ts INTEGER,
    last_ts INTEGER,
    frames INTEGER NOT NULL,
    data BLOB NOT NULL
  );

  -- one row per stored second
  CREATE TABLE samples (
    ts INTEGER PRIMARY KEY,
    hr INTEGER NOT NULL,
    rr BLOB,
    gx REAL, gy REAL, gz REAL,
    contact INTEGER NOT NULL,
    temp REAL,
    spo2_red INTEGER,
    spo2_ir INTEGER
  ) WITHOUT ROWID;

  -- per-minute aggregates for charts and the stress monitor
  CREATE TABLE minutes (
    ts INTEGER PRIMARY KEY,
    hr REAL, hr_min INTEGER, hr_max INTEGER,
    rmssd REAL,
    motion REAL,
    stress REAL,
    state TEXT NOT NULL            -- off | sleep | workout | active | rest
  ) WITHOUT ROWID;

  CREATE TABLE sleeps (
    id INTEGER PRIMARY KEY,
    start INTEGER NOT NULL UNIQUE,
    end INTEGER NOT NULL,
    nap INTEGER NOT NULL,
    stages TEXT NOT NULL,          -- JSON [{start,end,stage}]
    metrics TEXT NOT NULL,         -- JSON SleepMetrics
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sleeps_end ON sleeps(end);

  -- physiological cycle: one main sleep onset to the next
  CREATE TABLE cycles (
    start INTEGER PRIMARY KEY,
    end INTEGER,
    sleep_id INTEGER,
    date TEXT NOT NULL,            -- local date of waking up
    sleep_score TEXT,              -- JSON need/performance/consistency/debt
    recovery TEXT,                 -- JSON RecoveryResult + vitals + baseline
    strain TEXT,                   -- JSON StrainResult
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX cycles_date ON cycles(date);

  CREATE TABLE workouts (
    id INTEGER PRIMARY KEY,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    sport TEXT NOT NULL,
    name TEXT,
    source TEXT NOT NULL,          -- detected | manual | live | strava
    external_id TEXT,
    strain REAL, avg_hr REAL, max_hr REAL, kcal REAL,
    zones TEXT,                    -- JSON seconds in zones 0-5
    meta TEXT,
    UNIQUE (source, external_id)
  );
  CREATE INDEX workouts_start ON workouts(start);

  CREATE TABLE journal (
    date TEXT NOT NULL,            -- cycle date the answers describe (the day before the recovery)
    question TEXT NOT NULL,
    answer INTEGER NOT NULL,
    PRIMARY KEY (date, question)
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX events_ts ON events(ts);

  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,          -- JSON array, ["*"] for all
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    last_delivery_at INTEGER
  );

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}',
    last_run_at INTEGER,
    last_error TEXT
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  for (; version < MIGRATIONS.length; version++) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    });
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

// ── key/value settings ────────────────────────────────────────────────

export function getMeta<T>(db: Db, key: string, fallback: T): T {
  const row = get<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key);
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setMeta(db: Db, key: string, value: unknown) {
  run(db, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
}

export const now = () => Math.floor(Date.now() / 1000);
