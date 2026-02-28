import { TaskPriority } from "./types.js";

const VALID_PRIORITIES: TaskPriority[] = ["low", "normal", "high"];

export function validatePrompt(p: unknown): string {
  if (typeof p !== "string") throw new Error(`Prompt must be a string, got ${typeof p}`);
  const trimmed = p.trim();
  if (trimmed.length === 0) throw new Error("Prompt must be a non-empty string");
  return trimmed;
}

export function validateTimeout(t: unknown): number | undefined {
  if (t === undefined || t === null) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`Timeout must be a positive number, got ${t}`);
  return n;
}

export function validateMaxBudget(b: unknown): number | undefined {
  if (b === undefined || b === null) return undefined;
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`Max budget must be a positive number, got ${b}`);
  return n;
}

export function validatePriority(p: unknown): TaskPriority | undefined {
  if (p === undefined || p === null) return undefined;
  if (!VALID_PRIORITIES.includes(p as TaskPriority))
    throw new Error(`Priority must be one of ${VALID_PRIORITIES.join(", ")}, got ${p}`);
  return p as TaskPriority;
}
