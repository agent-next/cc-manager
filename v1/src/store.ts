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
        priority TEXT DEFAULT 'normal'
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
  }

  save(task: Task): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks
      (id, prompt, status, worktree, output, error, events, created_at,
       started_at, completed_at, timeout, max_budget, cost_usd,
       token_input, token_output, duration_ms, retry_count, max_retries, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.prompt, task.status, task.worktree ?? null,
      task.output, task.error, JSON.stringify(task.events),
      task.createdAt, task.startedAt ?? null, task.completedAt ?? null,
      task.timeout, task.maxBudget, task.costUsd,
      task.tokenInput, task.tokenOutput, task.durationMs, task.retryCount, task.maxRetries,
      task.priority ?? "normal",
    );
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
    };
  }

  close(): void {
    this.db.close();
  }
}
