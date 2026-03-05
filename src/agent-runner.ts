import { type Task, type TaskEvent, type ReviewResult, createTask } from "./types.js";
import { log } from "./logger.js";
import { spawn, type ChildProcess } from "node:child_process";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";

const execAsync = promisify(execCb);

type EventCallback = (event: Record<string, unknown>) => void;

const MAX_EVENTS = 200;
const SIGKILL_GRACE_MS = 5_000;

interface ChildTimers {
  clear(): void;
}

/** Wire timeout + SIGTERM → SIGKILL escalation for a child process. */
function setupChildTimeout(child: ChildProcess, task: Task): ChildTimers {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (task.timeout > 0) {
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      task.status = "timeout";
      task.error = `timeout: task exceeded ${task.timeout}s`;
    }, task.timeout * 1000);
  }
  return {
    clear() {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    },
  };
}

interface RunningTaskEntry {
  id: string;
  startMs: number;
  costUsd: number;
  process?: ChildProcess;
  abortController?: AbortController;
}

export interface RunningTaskInfo {
  id: string;
  elapsedMs: number;
  costUsd: number;
}

export type { ReviewResult };

export class AgentRunner {
  private readonly _runningTasks = new Map<string, RunningTaskEntry>();

  constructor(
    private model: string = "claude-sonnet-4-6",
    private systemPrompt: string = "",
    private defaultAgent: string = "claude",
  ) {}

  /** Estimates USD cost for a given token usage and model. */
  static estimateCost(tokenInput: number, tokenOutput: number, model: string): number {
    const rates: Record<string, { input: number; output: number }> = {
      "claude-sonnet-4-6": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
      "claude-opus-4-5": { input: 15 / 1_000_000, output: 75 / 1_000_000 },
    };
    const r = rates[model] ?? rates["claude-sonnet-4-6"];
    return tokenInput * r.input + tokenOutput * r.output;
  }

  /** Reviews a git diff and returns a score with issues and suggestions. */
  reviewDiff(diff: string): ReviewResult {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let score = 50;

    if (/\.(test|spec)\.(ts|js|tsx|jsx)/.test(diff)) {
      score += 20;
      suggestions.push("Good: changes include test files.");
    }

    if (/console\.log/.test(diff)) {
      issues.push("Avoid leaving console.log statements in production code.");
      score -= 10;
    }

    return { approve: score >= 40, score, issues, suggestions };
  }

  /**
   * Select the cross-review agent: the reviewer should be a different agent
   * than the one that wrote the code.
   */
  static pickReviewAgent(taskAgent: string): string {
    if (taskAgent === "codex") return "claude";
    if (taskAgent === "claude" || taskAgent === "claude-sdk") return "codex";
    return "claude"; // generic agents reviewed by claude
  }

  /**
   * Returns a fallback agent different from the current one.
   * If current is "codex", returns "claude"; otherwise returns "codex".
   */
  static pickFallbackAgent(current: string): string {
    return current === "codex" ? "claude" : "codex";
  }

  /**
   * Spawn a cross-agent to review a git diff. Returns a structured ReviewResult.
   * Falls back to the heuristic reviewDiff() if the agent fails or times out.
   */
  async reviewDiffWithAgent(
    diff: string,
    taskAgent: string,
    timeout: number = 60,
  ): Promise<ReviewResult> {
    const reviewAgent = AgentRunner.pickReviewAgent(taskAgent);
    const truncatedDiff = diff.length > 50_000 ? diff.slice(0, 50_000) + "\n... (truncated)" : diff;

    const reviewPrompt = [
      "You are a code reviewer. Review the following git diff and respond with ONLY a JSON object (no markdown, no explanation).",
      "",
      "IMPORTANT: Do NOT modify any files. Do NOT run any commands. Only output your JSON review.",
      "",
      "Evaluate:",
      "1. Correctness: Are there bugs, logic errors, or missing edge cases?",
      "2. Quality: Is the code clean, readable, and maintainable?",
      "3. Safety: Are there security issues, hardcoded secrets, or dangerous patterns?",
      "",
      "Respond with exactly this JSON format:",
      '{"approve": true/false, "score": 0-100, "issues": ["issue1", ...], "suggestions": ["suggestion1", ...]}',
      "",
      "approve=true means the code is ready to merge. approve=false means it needs fixes.",
      "Be pragmatic — minor style issues should not block merge. Focus on correctness and safety.",
      "",
      "```diff",
      truncatedDiff,
      "```",
    ].join("\n");

    const reviewTask = createTask(reviewPrompt, {
      agent: reviewAgent,
      timeout,
      maxBudget: 1,
    });

    try {
      log("info", "cross-agent review started", { taskAgent, reviewAgent });
      // Run review in /tmp to prevent the reviewer from modifying the worktree
      await this.run(reviewTask, "/tmp");

      if (reviewTask.status !== "success" || !reviewTask.output) {
        log("warn", "cross-agent review did not succeed, falling back to heuristic", {
          status: reviewTask.status,
          error: reviewTask.error,
        });
        return { ...this.reviewDiff(diff), reviewAgent: `${reviewAgent} (fallback)` };
      }

      // Parse the JSON response from the review agent
      const parsed = this.parseReviewResponse(reviewTask.output);
      if (parsed) {
        parsed.reviewAgent = reviewAgent;
        log("info", "cross-agent review complete", {
          reviewAgent,
          approve: parsed.approve,
          score: parsed.score,
          issueCount: parsed.issues.length,
        });
        return parsed;
      }

      log("warn", "cross-agent review response unparseable, falling back to heuristic");
      return { ...this.reviewDiff(diff), reviewAgent: `${reviewAgent} (fallback)` };
    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      log("warn", "cross-agent review failed, falling back to heuristic", { error: msg });
      return { ...this.reviewDiff(diff), reviewAgent: `${reviewAgent} (fallback)` };
    }
  }

  /** Try to extract a ReviewResult JSON from agent output (may contain surrounding text). */
  private parseReviewResponse(output: string): ReviewResult | null {
    // Try direct JSON parse first
    try {
      const result = this.normalizeReviewObj(JSON.parse(output.trim()));
      if (result) return result;
    } catch { /* not pure JSON */ }

    // Try to extract JSON by finding the outermost { }
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const result = this.normalizeReviewObj(JSON.parse(output.slice(start, end + 1)));
        if (result) return result;
      } catch { /* not valid JSON */ }
    }

    return null;
  }

  private normalizeReviewObj(obj: Record<string, unknown>): ReviewResult | null {
    if (typeof obj.approve !== "boolean" || typeof obj.score !== "number") return null;
    return {
      approve: obj.approve,
      score: Math.max(0, Math.min(100, obj.score)),
      issues: Array.isArray(obj.issues) ? obj.issues.map(String) : [],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String) : [],
    };
  }

  /** Returns info about all tasks currently being executed by this runner. */
  getRunningTasks(): RunningTaskInfo[] {
    const now = Date.now();
    return Array.from(this._runningTasks.values()).map((entry) => ({
      id: entry.id,
      elapsedMs: now - entry.startMs,
      costUsd: entry.costUsd,
    }));
  }

  /** Returns a clean copy of process.env without Claude Code nesting detection vars. */
  private cleanEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_CODE_")) delete env[key];
    }
    return env;
  }

  private detectLanguage(cwd: string): "typescript" | "javascript" | "python" | "unknown" {
    if (existsSync(`${cwd}/tsconfig.json`)) return "typescript";
    if (existsSync(`${cwd}/pyproject.toml`) || existsSync(`${cwd}/setup.py`) || existsSync(`${cwd}/setup.cfg`)) return "python";
    if (existsSync(`${cwd}/package.json`)) return "javascript";
    return "unknown";
  }

  buildSystemPrompt(task: Task, cwd: string = process.cwd()): string {
    const parts: string[] = [];

    // Inject Development Rules from CLAUDE.md if present
    try {
      const claudeMd = readFileSync(`${cwd}/CLAUDE.md`, "utf8");
      const match = claudeMd.match(/## Development Rules\n([\s\S]*?)(?=\n## |$)/);
      if (match) {
        parts.push(match[1].trim());
      }
    } catch {
      // CLAUDE.md not found – skip gracefully
    }

    // Language-aware instructions
    const lang = this.detectLanguage(cwd);
    if (lang === "typescript") {
      parts.push("- Always use `.js` extensions in import paths (e.g. `import { foo } from \"./bar.js\"`).");
      parts.push("- After making changes, run `npx tsc` to verify there are no type errors.");
    } else if (lang === "python") {
      parts.push("- After making changes, run the project's test suite to verify.");
      parts.push("- Use the project's existing linter (ruff, flake8, etc.) if configured.");
    } else if (lang === "javascript") {
      parts.push("- After making changes, run `npm test` if configured.");
    }
    parts.push("- Stage and commit all changes with `git add -A && git commit -m \"feat: <brief summary>\"`.");

    // Conditional: test or spec
    const lower = task.prompt.toLowerCase();
    if (/\btest\b|\bspec\b/.test(lower)) {
      parts.push("- Use `node:test` as the test runner and `assert/strict` for assertions.");
    }

    // Conditional: dashboard or html
    if (/\bdashboard\b|\bhtml\b/.test(lower)) {
      parts.push("- Keep JavaScript vanilla (no frameworks). Match the existing dark theme.");
    }

    // Conditional: specific file mention
    const fileMatch = task.prompt.match(/\b([\w./\\-]+\.(?:ts|js|tsx|jsx|mts|mjs|cjs|html|css|json|md|py|sh))\b/i);
    if (fileMatch) {
      parts.push(`- Only modify the file \`${fileMatch[1]}\`. Do not touch any other files.`);
    }

    return parts.join("\n");
  }

  /** Runs a task using the appropriate CLI agent. */
  async run(task: Task, cwd: string, onEvent?: EventCallback): Promise<Task> {
    const agent = task.agent ?? this.defaultAgent;

    task.status = "running";
    task.startedAt = new Date().toISOString();
    const startMs = Date.now();

    this._runningTasks.set(task.id, { id: task.id, startMs, costUsd: 0 });

    log("info", "task start", { taskId: task.id, worker: task.worktree, agent });
    onEvent?.({ type: "task_started", taskId: task.id, worker: task.worktree, agent });

    try {
      if (agent === "claude-sdk") {
        await this.runClaudeSDK(task, cwd, startMs, onEvent);
      } else if (agent === "claude") {
        await this.runClaude(task, cwd, startMs, onEvent);
      } else if (agent === "codex") {
        await this.runCodex(task, cwd, startMs, onEvent);
      } else {
        await this.runGeneric(task, cwd, agent, startMs, onEvent);
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string; code?: string };
      const msg = e.message ?? String(err);

      if (e.name === "AbortError" || msg.includes("timeout")) {
        task.status = "timeout";
        task.error = `timeout: task exceeded ${task.timeout}s`;
      } else if ((task.status as string) !== "timeout") {
        task.status = "failed";
        task.error = `agent: ${msg}`;
      }
      task.durationMs = Date.now() - startMs;
    } finally {
      this._runningTasks.delete(task.id);
    }

    // Capture git diff for any commits made by the agent
    try {
      const { stdout: diff } = await execAsync("git diff HEAD~1..HEAD", { cwd, encoding: "utf8" });
      if (diff.trim()) {
        const diffEvt: TaskEvent = {
          type: "git_diff",
          timestamp: new Date().toISOString(),
          data: { diff },
        };
        this.pushEvent(task, diffEvt);
        onEvent?.({ type: "task_event", taskId: task.id, event: diffEvt });
      }
    } catch {
      // No commits or git unavailable
    }

    // Post-execution build verification — tsc failure blocks merge
    if ((task.status as string) === "success") {
      const buildResult = await this.verifyBuild(cwd);
      if (!buildResult.ok) {
        task.status = "failed";
        task.output = "[TSC_FAILED] " + (task.output ?? "");
        task.error = buildResult.errors;
        log("warn", "build verification failed", { taskId: task.id, errors: buildResult.errors });
      }
    }

    task.completedAt = new Date().toISOString();
    log("info", "task complete", {
      taskId: task.id,
      status: task.status,
      costUsd: task.costUsd,
      durationMs: task.durationMs,
      agent,
    });
    onEvent?.({ type: "task_completed", taskId: task.id, status: task.status });
    return task;
  }

  /** Run task using Claude Agent SDK (programmatic control with structured events). */
  private async runClaudeSDK(task: Task, cwd: string, startMs: number, onEvent?: EventCallback): Promise<void> {
    let query: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    try {
      ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
    } catch {
      throw new Error("claude-sdk agent requires @anthropic-ai/claude-agent-sdk. Install: npm install @anthropic-ai/claude-agent-sdk");
    }

    const sysPrompt = this.buildSystemPrompt(task, cwd);
    const fullPrompt = this.buildTaskPrompt(task, cwd);
    const env = this.cleanEnv();

    const ac = new AbortController();
    const entry = this._runningTasks.get(task.id);
    if (entry) entry.abortController = ac;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (task.timeout > 0) {
      timer = setTimeout(() => {
        ac.abort();
        task.status = "timeout";
        task.error = `timeout: task exceeded ${task.timeout}s`;
      }, task.timeout * 1000);
    }

    try {
      const conversation = query({
        prompt: fullPrompt,
        options: {
          cwd,
          env,
          model: task.modelOverride ?? task.model ?? this.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 50,
          maxBudgetUsd: task.maxBudget > 0 ? task.maxBudget : undefined,
          systemPrompt: sysPrompt ? { type: "preset", preset: "claude_code", append: sysPrompt } : undefined,
          abortController: ac,
          persistSession: false,
        },
      });

      for await (const msg of conversation) {
        // Reuse the shared Claude event handler — SDK messages match the CLI stream-json format
        this.handleClaudeEvent(msg as Record<string, unknown>, task, startMs, onEvent);
      }

      // Stream ended without a result message — not a success
      if (task.status === "running") {
        task.status = "failed";
        task.error = "SDK stream ended without result message";
        task.durationMs = Date.now() - startMs;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Run task using Claude CLI (non-interactive mode with stream-json output). */
  private runClaude(task: Task, cwd: string, startMs: number, onEvent?: EventCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const sysPrompt = this.buildSystemPrompt(task, cwd);
      const fullPrompt = this.buildTaskPrompt(task, cwd);

      const args = [
        "-p",
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--verbose",
        "--model", task.modelOverride ?? task.model ?? this.model,
      ];
      if (task.maxBudget > 0) {
        args.push("--max-budget-usd", String(task.maxBudget));
      }
      if (sysPrompt) {
        args.push("--append-system-prompt", sysPrompt);
      }
      args.push(fullPrompt);

      const env = this.cleanEnv();

      const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const entry = this._runningTasks.get(task.id);
      if (entry) entry.process = child;

      let stdout = "";
      let stderr = "";
      const timers = setupChildTimeout(child, task);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            this.handleClaudeEvent(msg, task, startMs, onEvent);
          } catch {
            // Not valid JSON, accumulate as raw output
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        timers.clear();
        task.durationMs = Date.now() - startMs;

        if ((task.status as string) === "timeout") {
          resolve();
          return;
        }

        if (code === 0 && task.status === "running") {
          task.status = "success";
          if (!task.output) {
            task.output = this.extractClaudeOutput(stdout);
          }
          task.summary = task.output.slice(-500);
        } else if (task.status === "running") {
          task.status = "failed";
          task.error = stderr || `claude exited with code ${code}`;
        }
        resolve();
      });

      child.on("error", (err) => {
        timers.clear();
        reject(err);
      });
    });
  }

  /** Parse Claude event (shared by SDK and CLI paths) and update task metrics. */
  private handleClaudeEvent(msg: Record<string, unknown>, task: Task, startMs: number, onEvent?: EventCallback): void {
    const type = msg.type as string | undefined;
    const isTerminal = task.status !== "running";

    if (type === "assistant" && !isTerminal) {
      const content = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (content?.content) {
        const text = content.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text as string)
          .join("");
        if (text) {
          onEvent?.({ type: "task_log", taskId: task.id, text });
        }
      }
    }

    if (type === "result") {
      // Always capture metrics, even after timeout
      task.costUsd = (msg.total_cost_usd as number) ?? 0;
      const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      task.tokenInput = usage?.input_tokens ?? 0;
      task.tokenOutput = usage?.output_tokens ?? 0;
      task.durationMs = (msg.duration_ms as number) ?? (Date.now() - startMs);

      const entry = this._runningTasks.get(task.id);
      if (entry) entry.costUsd = task.costUsd;

      // Only mutate status if still running — don't overwrite timeout/cancelled
      if (!isTerminal) {
        const subtype = msg.subtype as string | undefined;
        if (subtype === "success") {
          task.status = "success";
          task.output = (msg.result as string) ?? "";
          task.summary = task.output.slice(-500);
        } else {
          task.status = "failed";
          const errors = msg.errors as string[] | undefined;
          task.error = errors?.length ? errors.join("; ") : (subtype ?? "unknown error");
        }
      }
    }

    this.pushEvent(task, { type: type ?? "unknown", timestamp: new Date().toISOString() });
    onEvent?.({ type: "task_event", taskId: task.id, event: { type: type ?? "unknown" } });
  }

  /** Extract text output from Claude CLI raw JSONL stdout. */
  private extractClaudeOutput(stdout: string): string {
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "result" && msg.result) return msg.result;
      } catch { /* skip */ }
    }
    return stdout.slice(-2000);
  }

  /** Run task using Codex CLI (exec mode with JSON output). */
  private runCodex(task: Task, cwd: string, startMs: number, onEvent?: EventCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const fullPrompt = this.buildTaskPrompt(task, cwd);

      const args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--cd", cwd,
        "-m", this.model.startsWith("claude") ? "o4-mini" : this.model,
        fullPrompt,
      ];

      const child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const entry = this._runningTasks.get(task.id);
      if (entry) entry.process = child;

      let stdout = "";
      let stderr = "";
      const timers = setupChildTimeout(child, task);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            this.handleCodexEvent(msg, task, startMs, onEvent);
          } catch {
            // raw output
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        timers.clear();
        task.durationMs = Date.now() - startMs;

        if ((task.status as string) === "timeout") {
          resolve();
          return;
        }

        if (code === 0 && task.status === "running") {
          task.status = "success";
          if (!task.output) {
            task.output = this.extractCodexOutput(stdout);
          }
          task.summary = task.output.slice(-500);
        } else if (task.status === "running") {
          task.status = "failed";
          task.error = stderr || `codex exited with code ${code}`;
        }
        resolve();
      });

      child.on("error", (err) => {
        timers.clear();
        reject(err);
      });
    });
  }

  /** Parse Codex CLI JSONL event. */
  private handleCodexEvent(msg: Record<string, unknown>, task: Task, startMs: number, onEvent?: EventCallback): void {
    const type = msg.type as string | undefined;

    if (type === "item.completed") {
      const item = msg.item as { type?: string; content?: Array<{ text?: string }> } | undefined;
      if (item?.type === "agent_message" && item.content) {
        const text = item.content.map((c) => c.text ?? "").join("");
        if (text) {
          onEvent?.({ type: "task_log", taskId: task.id, text });
        }
      }
    }

    if (type === "turn.completed") {
      const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (usage) {
        task.tokenInput += usage.input_tokens ?? 0;
        task.tokenOutput += usage.output_tokens ?? 0;
        // Codex doesn't report cost — estimate from OpenAI pricing
        task.costUsd = (task.tokenInput * 1.1 / 1_000_000) + (task.tokenOutput * 4.4 / 1_000_000);
        const entry = this._runningTasks.get(task.id);
        if (entry) entry.costUsd = task.costUsd;
      }
    }

    this.pushEvent(task, { type: type ?? "unknown", timestamp: new Date().toISOString() });
    onEvent?.({ type: "task_event", taskId: task.id, event: { type: type ?? "unknown" } });
  }

  /** Extract output from Codex CLI raw JSONL. */
  private extractCodexOutput(stdout: string): string {
    const outputs: string[] = [];
    for (const line of stdout.split("\n").filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "item.completed" && msg.item?.type === "agent_message") {
          const text = (msg.item.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
          if (text) outputs.push(text);
        }
      } catch { /* skip */ }
    }
    return outputs.join("\n") || stdout.slice(-2000);
  }

  /** Run task using any generic CLI command. The prompt is appended as the last argument. */
  private runGeneric(task: Task, cwd: string, agentCmd: string, startMs: number, onEvent?: EventCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const fullPrompt = this.buildTaskPrompt(task, cwd);

      // Split the agent command on whitespace: e.g. "aider --yes" → ["aider", "--yes"]
      const parts = agentCmd.split(/\s+/).filter(Boolean);
      const cmd = parts[0];
      const args = [...parts.slice(1), fullPrompt];

      const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const entry = this._runningTasks.get(task.id);
      if (entry) entry.process = child;

      let stdout = "";
      let stderr = "";
      const timers = setupChildTimeout(child, task);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        onEvent?.({ type: "task_progress", taskId: task.id, elapsedMs: Date.now() - startMs });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        timers.clear();
        task.durationMs = Date.now() - startMs;

        if ((task.status as string) === "timeout") {
          resolve();
          return;
        }

        if (code === 0 && task.status === "running") {
          task.status = "success";
          task.output = stdout.slice(-5000);
          task.summary = task.output.slice(-500);
        } else if (task.status === "running") {
          task.status = "failed";
          task.error = stderr || `${cmd} exited with code ${code}`;
          task.output = stdout.slice(-5000);
        }
        resolve();
      });

      child.on("error", (err) => {
        timers.clear();
        reject(err);
      });
    });
  }

  /** Build the full task prompt with instructions appended. */
  private buildTaskPrompt(task: Task, cwd: string = process.cwd()): string {
    const lang = this.detectLanguage(cwd);
    const lines: string[] = [
      `${task.prompt}`,
      "",
      "---",
      "",
      "## Instructions",
      "",
      "- **Minimal changes**: Only modify what is necessary to complete the task. Do not refactor, reformat, or touch unrelated code.",
    ];

    if (lang === "typescript") {
      lines.push("- **TypeScript imports**: Always use `.js` extensions in import paths (e.g. `import { foo } from \"./bar.js\"`).");
      lines.push("- **Type checking**: After making changes, run `npx tsc` to catch type errors.");
      lines.push("- **Fix before committing**: If `npx tsc` fails, fix all errors before proceeding to commit.");
      lines.push("- **Commit when done**: Stage and commit all changes with `git add -A && git commit -m \"feat: <brief summary>\"`.");
    } else if (lang === "python") {
      lines.push("- **Python project**: Use the project's build system (pyproject.toml / setup.py).");
      lines.push("- **Verification**: Run relevant tests to verify changes work.");
      lines.push("- **Commit when done**: Stage and commit with `git add -A && git commit -m \"feat: <brief summary>\"`.");
    } else if (lang === "javascript") {
      lines.push("- **Verification**: Run `npm test` if configured.");
      lines.push("- **Commit when done**: Stage and commit with `git add -A && git commit -m \"feat: <brief summary>\"`.");
    } else {
      lines.push("- **Commit when done**: Stage and commit with `git add -A && git commit -m \"feat: <brief summary>\"`.");
    }

    return lines.join("\n");
  }

  /** Async build verification — does not block the event loop. */
  private async verifyBuild(cwd: string): Promise<{ ok: boolean; errors: string }> {
    const lang = this.detectLanguage(cwd);
    if (lang !== "typescript") {
      return { ok: true, errors: "" };
    }
    try {
      await execAsync("npx tsc --noEmit", { cwd, encoding: "utf8" });
      return { ok: true, errors: "" };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const errors = ((e.stdout ?? "") + (e.stderr ?? "")).trim() || (e.message ?? "unknown tsc error");
      return { ok: false, errors };
    }
  }

  /** Push event to task, capping at MAX_EVENTS to prevent unbounded growth. */
  private pushEvent(task: Task, evt: TaskEvent): void {
    if (task.events.length >= MAX_EVENTS) {
      task.events.shift();
    }
    task.events.push(evt);
  }

  /** Kill a running task's process or abort SDK query. */
  abort(taskId: string): boolean {
    const entry = this._runningTasks.get(taskId);
    if (!entry) return false;
    if (entry.process) {
      entry.process.kill("SIGTERM");
      return true;
    }
    if (entry.abortController) {
      entry.abortController.abort();
      return true;
    }
    return false;
  }
}
