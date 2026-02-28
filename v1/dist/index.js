import { Command } from "commander";
import { WorktreePool } from "./worktree-pool.js";
import { AgentRunner } from "./agent-runner.js";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { WebServer } from "./server.js";
const program = new Command()
    .name("cc-manager")
    .description("Claude Code multi-agent orchestrator")
    .requiredOption("--repo <path>", "Git repository path")
    .option("--workers <n>", "Number of parallel workers", "10")
    .option("--port <n>", "HTTP server port", "8080")
    .option("--timeout <s>", "Task timeout in seconds", "300")
    .option("--budget <usd>", "Max budget per task in USD", "5")
    .option("--model <id>", "Claude model ID", "claude-sonnet-4-6")
    .option("--system-prompt <text>", "System prompt for all agents", "")
    .parse();
const opts = program.opts();
async function main() {
    console.log("CC-Manager V1 starting...");
    console.log(`  repo:    ${opts.repo}`);
    console.log(`  workers: ${opts.workers}`);
    console.log(`  port:    ${opts.port}`);
    console.log(`  model:   ${opts.model}`);
    const pool = new WorktreePool(opts.repo, parseInt(opts.workers));
    await pool.init();
    const runner = new AgentRunner(opts.model, opts.systemPrompt);
    const store = new Store(opts.repo);
    const server = new WebServer(pool, parseInt(opts.port));
    const scheduler = new Scheduler(pool, runner, store, (event) => {
        server.broadcast(event);
    });
    server.setScheduler(scheduler);
    scheduler.start();
    server.start();
    const shutdown = async () => {
        console.log("\nShutting down...");
        await scheduler.stop();
        store.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map