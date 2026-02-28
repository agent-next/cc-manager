import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export class WebServer {
    pool;
    port;
    app = new Hono();
    sseClients = new Set();
    _scheduler;
    constructor(pool, port) {
        this.pool = pool;
        this.port = port;
        this.setupRoutes();
    }
    setScheduler(scheduler) {
        this._scheduler = scheduler;
    }
    setupRoutes() {
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
            if (!task)
                return c.json({ error: "not found" }, 404);
            return c.json(task);
        });
        // API: submit task
        app.post("/api/tasks", async (c) => {
            const body = await c.req.json();
            if (!body.prompt)
                return c.json({ error: "prompt required" }, 400);
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
                const send = (data) => {
                    stream.writeSSE({ data }).catch(() => { });
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
    broadcast(event) {
        const data = JSON.stringify(event);
        for (const send of this.sseClients) {
            try {
                send(data);
            }
            catch {
                this.sseClients.delete(send);
            }
        }
    }
    start() {
        serve({ fetch: this.app.fetch, port: this.port }, (info) => {
            console.log(`[server] http://localhost:${info.port}`);
        });
    }
}
//# sourceMappingURL=server.js.map