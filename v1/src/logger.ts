type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
