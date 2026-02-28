import Database from "better-sqlite3";
import path from "node:path";
import type { Task } from "./types.js";

export class Store {
  private db: Database.Database;

  constructor(repoPath: string) {
    const dbPath = path.join(repoPath, ".cc-manager.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        worktree TEXT,
        output TEXT DEFAULT '',
        error TEXT DEFAULT '',
        events TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        timeout INTEGER DEFAULT 300,
        max_budget REAL DEFAULT 5,
        cost_usd REAL DEFAULT 0,
        token_input INTEGER DEFAULT 0,
        token_output INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 2,
        priority TEXT DEFAULT 'normal',
        tags TEXT DEFAULT '[]'
      )
    `);
    // Add max_retries column to existing databases that predate this migration
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT 2");
    } catch {
      // Column already exists — safe to ignore
    }
    // Add priority column to existing databases that predate this migration
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'normal'");
    } catch {
      // Column already exists — safe to ignore
    }
    // Add tags column to existing databases that predate this migration
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'");
    } catch {
      // Column already exists — safe to ignore
    }
    // Indexes for common query patterns
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)"
    );
  }

  save(task: Task): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks
      (id, prompt, status, worktree, output, error, events, created_at,
       started_at, completed_at, timeout, max_budget, cost_usd,
       token_input, token_output, duration_ms, retry_count, max_retries, priority, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.prompt, task.status, task.worktree ?? null,
      task.output, task.error, JSON.stringify(task.events),
      task.createdAt, task.startedAt ?? null, task.completedAt ?? null,
      task.timeout, task.maxBudget, task.costUsd,
      task.tokenInput, task.tokenOutput, task.durationMs, task.retryCount, task.maxRetries,
      task.priority ?? "normal",
      JSON.stringify(task.tags ?? []),
    );
  }

  /**
   * Update multiple tasks in a single transaction using a prepared statement.
   * Significantly faster than calling save() in a loop when many tasks complete
   * near-simultaneously, because SQLite only flushes WAL once per transaction.
   */
  updateBatch(tasks: Task[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tasks
      (id, prompt, status, worktree, output, error, events, created_at,
       started_at, completed_at, timeout, max_budget, cost_usd,
       token_input, token_output, duration_ms, retry_count, max_retries, priority, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const runAll = this.db.transaction((batch: Task[]) => {
      for (const task of batch) {
        stmt.run(
          task.id, task.prompt, task.status, task.worktree ?? null,
          task.output, task.error, JSON.stringify(task.events),
          task.createdAt, task.startedAt ?? null, task.completedAt ?? null,
          task.timeout, task.maxBudget, task.costUsd,
          task.tokenInput, task.tokenOutput, task.durationMs, task.retryCount, task.maxRetries,
          task.priority ?? "normal",
          JSON.stringify(task.tags ?? []),
        );
      }
    });
    runAll(tasks);
  }

  /**
   * Update only the specified fields of a task using a targeted SQL SET clause.
   * More efficient than save() when only a few fields change.
   * Returns the updated Task, or null if no task with that id exists.
   */
  update(id: string, fields: Partial<Task>): Task | null {
    const fieldMap: Record<string, { col: string; serialize?: (v: unknown) => unknown }> = {
      prompt:      { col: "prompt" },
      status:      { col: "status" },
      worktree:    { col: "worktree" },
      output:      { col: "output" },
      error:       { col: "error" },
      events:      { col: "events",      serialize: (v) => JSON.stringify(v) },
      createdAt:   { col: "created_at" },
      startedAt:   { col: "started_at" },
      completedAt: { col: "completed_at" },
      timeout:     { col: "timeout" },
      maxBudget:   { col: "max_budget" },
      costUsd:     { col: "cost_usd" },
      tokenInput:  { col: "token_input" },
      tokenOutput: { col: "token_output" },
      durationMs:  { col: "duration_ms" },
      retryCount:  { col: "retry_count" },
      maxRetries:  { col: "max_retries" },
      priority:    { col: "priority" },
      tags:        { col: "tags",        serialize: (v) => JSON.stringify(v) },
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, mapping] of Object.entries(fieldMap)) {
      if (key in fields) {
        setClauses.push(`${mapping.col} = ?`);
        const val = (fields as Record<string, unknown>)[key];
        values.push(mapping.serialize ? mapping.serialize(val) : (val ?? null));
      }
    }

    if (setClauses.length === 0) {
      return this.get(id);
    }

    values.push(id);
    const result = this.db
      .prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);

    if (result.changes === 0) {
      return null;
    }

    return this.get(id);
  }

  get(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  list(limit = 100): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  search(query: string): Task[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE prompt LIKE ? OR output LIKE ? ORDER BY created_at DESC LIMIT 50"
    ).all(pattern, pattern) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  stats(): { total: number; byStatus: Record<string, number>; totalCost: number } {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as cnt, SUM(cost_usd) as cost FROM tasks GROUP BY status"
    ).all() as any[];

    let total = 0;
    let totalCost = 0;
    const byStatus: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = r.cnt;
      total += r.cnt;
      totalCost += r.cost ?? 0;
    }
    return { total, byStatus, totalCost };
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      worktree: row.worktree ?? undefined,
      output: row.output,
      error: row.error,
      events: JSON.parse(row.events || "[]"),
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      timeout: row.timeout,
      maxBudget: row.max_budget,
      costUsd: row.cost_usd,
      tokenInput: row.token_input,
      tokenOutput: row.token_output,
      durationMs: row.duration_ms,
      retryCount: row.retry_count,
      maxRetries: row.max_retries ?? 2,
      priority: (row.priority ?? "normal") as import("./types.js").TaskPriority,
      tags: JSON.parse(row.tags || "[]"),
    };
  }

  /** Deletes tasks whose created_at is older than {@link days} days ago.
   *  Returns the number of rows deleted. */
  deleteOlderThan(days: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const result = this.db
      .prepare("DELETE FROM tasks WHERE created_at < ?")
      .run(cutoff.toISOString());
    return result.changes;
  }

  /** Returns all tasks whose status matches {@link status}, newest first. */
  getByStatus(status: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC")
      .all(status) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** Returns the {@link limit} most recent tasks that failed or timed out,
   *  newest first.  Each Task includes the full `error` field. */
  getRecentErrors(limit: number): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status IN ('failed', 'timeout') ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** Returns one entry per calendar day for the last 7 days (newest first).
   *  Days with no tasks are omitted.  `successRate` is in [0, 1]. */
  getDailyStats(): Array<{ date: string; count: number; cost: number; successRate: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const rows = this.db
      .prepare(
        `SELECT
          substr(created_at, 1, 10)                          AS date,
          COUNT(*)                                           AS count,
          COALESCE(SUM(cost_usd), 0)                         AS cost,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count
        FROM tasks
        WHERE created_at >= ?
        GROUP BY date
        ORDER BY date DESC`
      )
      .all(cutoff.toISOString()) as any[];

    return rows.map((r) => ({
      date: r.date as string,
      count: r.count as number,
      cost: r.cost as number,
      successRate: r.count > 0 ? (r.success_count as number) / (r.count as number) : 0,
    }));
  }

  close(): void {
    this.db.close();
  }
}
