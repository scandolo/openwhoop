// Environment configuration. Every option has a local-first default.
import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  password: string | null;
  auth: "auto" | "on" | "off";
  loopback: boolean;
  publicUrl: string | null; // for OAuth callbacks behind a proxy
  rawRetentionDays: number;
  webDir: string;
}

export function loadConfig(env = process.env): Config {
  const host = env.HOST ?? "127.0.0.1";
  const dataDir = resolve(env.OPENWHOOP_DATA_DIR ?? "data");
  const auth = (env.OPENWHOOP_AUTH ?? "auto") as Config["auth"];
  return {
    host,
    port: Number(env.PORT ?? 8787),
    dataDir,
    dbPath: resolve(dataDir, "openwhoop.db"),
    password: env.OPENWHOOP_PASSWORD || null,
    auth: ["auto", "on", "off"].includes(auth) ? auth : "auto",
    // "on" forces a password even on localhost
    loopback: (host === "127.0.0.1" || host === "localhost" || host === "::1") && auth !== "on",
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, "") || null,
    rawRetentionDays: Number(env.RAW_RETENTION_DAYS ?? 30),
    webDir: resolve(env.OPENWHOOP_WEB_DIR ?? "dist/web"),
  };
}
