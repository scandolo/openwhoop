// `npm run dev`: API server with --watch plus the Vite dev server.
import { spawn } from "node:child_process";

const procs = [
  spawn("node", ["--watch", "src/server/main.ts"], { stdio: "inherit", env: { ...process.env, PORT: process.env.PORT ?? "8787" } }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
