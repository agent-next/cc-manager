export class CCManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "CCManagerError";
  }
}

export class TaskNotFoundError extends CCManagerError {
  constructor(id?: string) {
    super(id ? `Task not found: ${id}` : "Task not found", "TASK_NOT_FOUND", 404);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidInputError extends CCManagerError {
  constructor(detail?: string) {
    super(detail ? `Invalid input: ${detail}` : "Invalid input", "INVALID_INPUT", 400);
    this.name = "InvalidInputError";
  }
}

export class BudgetExceededError extends CCManagerError {
  constructor(detail?: string) {
    super(detail ? `Budget exceeded: ${detail}` : "Budget limit exceeded", "BUDGET_EXCEEDED", 429);
    this.name = "BudgetExceededError";
  }
}

export class WorkerUnavailableError extends CCManagerError {
  constructor(detail?: string) {
    super(detail ? `Worker unavailable: ${detail}` : "No workers available", "WORKER_UNAVAILABLE", 503);
    this.name = "WorkerUnavailableError";
  }
}

export class MergeConflictError extends CCManagerError {
  constructor(detail?: string) {
    super(detail ? `Merge conflict: ${detail}` : "Merge conflict detected", "MERGE_CONFLICT", 409);
    this.name = "MergeConflictError";
  }
}

export function toHttpError(err: unknown): { code: string; message: string; statusCode: number } {
  if (err instanceof CCManagerError) {
    return { code: err.code, message: err.message, statusCode: err.statusCode };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL_ERROR", message, statusCode: 500 };
}
