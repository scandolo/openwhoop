// Built-in integrations. Each one is a small module implementing the
// Integration interface (store.ts); add yours to INTEGRATIONS. Generic needs
// (Zapier, n8n, Home Assistant, your own scripts) are covered by webhooks +
// API tokens instead.
import type { Integration } from "./store.ts";
import { strava } from "./strava.ts";
import { whoop } from "./whoop.ts";

export const INTEGRATIONS: Integration[] = [whoop, strava];

export { integrationRow, runIntegration, saveIntegration } from "./store.ts";
export type { Integration, IntegrationContext } from "./store.ts";
