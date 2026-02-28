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

    // API: submit task
    app.post("/api/tasks", async (c) => {
      const body = await c.req.json<{ prompt: string; timeout?: number; maxBudget?: number }>();
      if (!body.prompt) return c.json({ error: "prompt required" }, 400);
      const task = this._scheduler.submit(body.prompt, {
        timeout: body.timeout,
        maxBudget: body.maxBudget,
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
