import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Scheduler } from "./scheduler.js";
import type { WorktreePool } from "./worktree-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class WebServer {
  private app = new Hono();
  private sseClients = new Set<(data: string) => void>();
  private _scheduler!: Scheduler;

  constructor(
    private pool: WorktreePool,
    private port: number,
  ) {
    this.setupRoutes();
  }

  setScheduler(scheduler: Scheduler): void {
    this._scheduler = scheduler;
  }

  private setupRoutes(): void {
    const app = this.app;

    // Dashboard
    app.get("/", (c) => {
      const html = readFileSync(path.join(__dirname, "web", "index.html"), "utf-8");
      return c.html(html);
    });

    // API: health check
    app.get("/api/health", (c) => {
      const stats = this._scheduler.getStats();
      const workerList = this.pool.getStatus();
      return c.json({
        status: "ok",
        uptime: process.uptime(),
        version: "1.0.0",
        workers: {
          total: workerList.length,
          busy: this.pool.busy,
          available: this.pool.available,
        },
        tasks: {
          total: stats.total,
          running: stats.byStatus["running"] ?? 0,
          queued: stats.queueSize,
          success: stats.byStatus["success"] ?? 0,
          failed: stats.byStatus["failed"] ?? 0,
        },
        totalCost: stats.totalCost,
      });
    });

    // API: stats
    app.get("/api/stats", (c) => c.json(this._scheduler.getStats()));

    // API: list tasks
    app.get("/api/tasks", (c) => {
      const tasks = this._scheduler.listTasks().map((t) => ({
        id: t.id,
        prompt: t.prompt.slice(0, 200),
        status: t.status,
        worktree: t.worktree,
        costUsd: t.costUsd,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        durationMs: t.durationMs,
      }));
      return c.json(tasks);
    });

    // API: task detail
    app.get("/api/tasks/:id", (c) => {
      const task = this._scheduler.getTask(c.req.param("id"));
      if (!task) return c.json({ error: "not found" }, 404);
      return c.json(task);
    });

    // API: task output (plain text for easy curl consumption)
    app.get("/api/tasks/:id/output", (c) => {
      const task = this._scheduler.getTask(c.req.param("id"));
      if (!task) return c.text("not found", 404);
      return c.text(task.output);
    });

    // API: batch submit tasks
    app.post("/api/tasks/batch", async (c) => {
      let body: { prompts?: unknown; timeout?: unknown; maxBudget?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      if (!Array.isArray(body.prompts) || body.prompts.length === 0) {
        return c.json({ error: "prompts must be a non-empty array" }, 400);
      }
      if (body.prompts.length > 20) {
        return c.json({ error: "batch size cannot exceed 20 prompts" }, 400);
      }
      for (let i = 0; i < body.prompts.length; i++) {
        if (typeof body.prompts[i] !== "string" || (body.prompts[i] as string).trim() === "") {
          return c.json({ error: `prompts[${i}] must be a non-empty string` }, 400);
        }
      }
      if (body.timeout !== undefined && (typeof body.timeout !== "number" || body.timeout <= 0)) {
        return c.json({ error: "timeout must be a positive number" }, 400);
      }
      if (body.maxBudget !== undefined && (typeof body.maxBudget !== "number" || body.maxBudget <= 0)) {
        return c.json({ error: "maxBudget must be a positive number" }, 400);
      }
      const results = (body.prompts as string[]).map((prompt) => {
        const task = this._scheduler.submit(prompt, {
          timeout: body.timeout as number | undefined,
          maxBudget: body.maxBudget as number | undefined,
        });
        return { id: task.id, status: task.status };
      });
      return c.json(results, 201);
    });

    // API: submit task
    app.post("/api/tasks", async (c) => {
      let body: { prompt?: unknown; timeout?: unknown; maxBudget?: unknown; priority?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
        return c.json({ error: "prompt must be a non-empty string" }, 400);
      }
      if (body.timeout !== undefined && (typeof body.timeout !== "number" || body.timeout <= 0)) {
        return c.json({ error: "timeout must be a positive number" }, 400);
      }
      if (body.maxBudget !== undefined && (typeof body.maxBudget !== "number" || body.maxBudget <= 0)) {
        return c.json({ error: "maxBudget must be a positive number" }, 400);
      }
      if (body.priority !== undefined && !["low", "normal", "high"].includes(body.priority as string)) {
        return c.json({ error: 'priority must be "low", "normal", or "high"' }, 400);
      }
      const task = this._scheduler.submit(body.prompt, {
        timeout: body.timeout as number | undefined,
        maxBudget: body.maxBudget as number | undefined,
        priority: body.priority as "low" | "normal" | "high" | undefined,
      });
      return c.json({ id: task.id, status: task.status }, 201);
    });

    // API: cancel task
    app.delete("/api/tasks/:id", (c) => {
      const ok = this._scheduler.cancel(c.req.param("id"));
      return ok ? c.json({ ok: true }) : c.json({ error: "cannot cancel" }, 400);
    });

    // API: workers
    app.get("/api/workers", (c) => c.json(this.pool.getStatus()));

    // SSE: real-time event stream
    app.get("/api/events", (c) => {
      return streamSSE(c, async (stream) => {
        const send = (data: string) => {
          stream.writeSSE({ data }).catch(() => {});
        };
        this.sseClients.add(send);
        stream.onAbort(() => {
          this.sseClients.delete(send);
        });
        // Keep alive
        while (true) {
          await stream.writeSSE({ data: "" });
          await stream.sleep(15000);
        }
      });
    });
  }

  broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const send of this.sseClients) {
      try {
        send(data);
      } catch {
        this.sseClients.delete(send);
      }
    }
  }

  start(): void {
    serve({ fetch: this.app.fetch, port: this.port }, (info) => {
      console.log(`[server] http://localhost:${info.port}`);
    });
  }
}
