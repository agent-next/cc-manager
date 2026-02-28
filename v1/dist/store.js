import Database from "better-sqlite3";
import path from "node:path";
export class Store {
    db;
    constructor(repoPath) {
        const dbPath = path.join(repoPath, ".cc-manager.db");
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
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
        retry_count INTEGER DEFAULT 0
      )
    `);
    }
    save(task) {
        this.db.prepare(`
      INSERT OR REPLACE INTO tasks
      (id, prompt, status, worktree, output, error, events, created_at,
       started_at, completed_at, timeout, max_budget, cost_usd,
       token_input, token_output, duration_ms, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.prompt, task.status, task.worktree ?? null, task.output, task.error, JSON.stringify(task.events), task.createdAt, task.startedAt ?? null, task.completedAt ?? null, task.timeout, task.maxBudget, task.costUsd, task.tokenInput, task.tokenOutput, task.durationMs, task.retryCount);
    }
    get(id) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
        return row ? this.rowToTask(row) : null;
    }
    list(limit = 100) {
        const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit);
        return rows.map((r) => this.rowToTask(r));
    }
    stats() {
        const rows = this.db.prepare("SELECT status, COUNT(*) as cnt, SUM(cost_usd) as cost FROM tasks GROUP BY status").all();
        let total = 0;
        let totalCost = 0;
        const byStatus = {};
        for (const r of rows) {
            byStatus[r.status] = r.cnt;
            total += r.cnt;
            totalCost += r.cost ?? 0;
        }
        return { total, byStatus, totalCost };
    }
    rowToTask(row) {
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
        };
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=store.js.map