export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: Level = "info";

/** Set the minimum log level. Messages below this level are suppressed. */
export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Structured JSON logger. Only emits if `level` >= configured minimum. */
export function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}
