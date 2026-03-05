import { EventEmitter } from "node:events";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createTask } from "./types.js";
import type { Task } from "./types.js";
import type { AgentRunner } from "./agent-runner.js";
import type { Scheduler } from "./scheduler.js";
import type { PipelineStore } from "./pipeline-store.js";
import type { PipelineRun, PipelineConfig, DecomposeOutput, VerifyOutput, WaveResult } from "./pipeline-types.js";

type EventCallback = (event: Record<string, unknown>) => void;

const exec = promisify(execCb);

interface RepoContext {
  language: "typescript" | "javascript" | "python" | "unknown";
  fileTree: string;
  dependencies: string;
  fileCount: number;
  hasTests: boolean;
}

function getRepoContext(repoPath: string): RepoContext {
  // Detect language
  let language: RepoContext["language"] = "unknown";
  if (existsSync(join(repoPath, "tsconfig.json"))) language = "typescript";
  else if (existsSync(join(repoPath, "pyproject.toml")) || existsSync(join(repoPath, "setup.py"))) language = "python";
  else if (existsSync(join(repoPath, "package.json"))) language = "javascript";

  // File tree (2 levels, skip node_modules/.git/dist)
  const skip = new Set(["node_modules", ".git", "dist", ".cc-pipeline", ".cc-manager.db", ".cc-manager.db-wal", ".cc-manager.db-shm"]);
  const lines: string[] = [];
  let fileCount = 0;

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > 2) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      if (skip.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      let isDir: boolean;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      lines.push(`${prefix}${name}${isDir ? "/" : ""}`);
      if (isDir) walk(full, depth + 1, prefix + "  ");
      else fileCount++;
    }
  }
  walk(repoPath, 0, "");

  // Dependencies from package.json or pyproject.toml
  let dependencies = "";
  try {
    if (language === "typescript" || language === "javascript") {
      const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf-8"));
      const deps = Object.keys(pkg.dependencies ?? {});
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      dependencies = `deps: ${deps.join(", ") || "none"}\ndevDeps: ${devDeps.join(", ") || "none"}`;
    } else if (language === "python") {
      if (existsSync(join(repoPath, "pyproject.toml"))) {
        dependencies = readFileSync(join(repoPath, "pyproject.toml"), "utf-8").slice(0, 500);
      }
    }
  } catch { /* skip */ }

  // Check for test files
  const hasTests = lines.some(l => /test|spec|__tests__/.test(l));

  return { language, fileTree: lines.slice(0, 60).join("\n"), dependencies, fileCount, hasTests };
}

export class Pipeline extends EventEmitter {
  private approveResolvers = new Map<string, () => void>();
  private _runConfigs = new Map<string, PipelineConfig>();
  private _lastDecompose: DecomposeOutput | null = null;

  constructor(
    private runner: AgentRunner,
    private scheduler: Scheduler,
    private pipelineStore: PipelineStore,
    private repoPath: string,
    private broadcast: EventCallback,
    private config: PipelineConfig,
  ) {
    super();
  }

  start(goal: string, configOverrides?: Record<string, unknown>): PipelineRun {
    // Apply per-run config overrides via schema-driven merge
    const runConfig = { ...this.config };
    if (configOverrides) {
      const schema: Record<string, "number" | "boolean"> = {
        maxIterations: "number", metaTaskTimeout: "number",
        codeTaskTimeout: "number", codeTaskBudget: "number",
        totalBudget: "number", autoApprove: "boolean",
      };
      for (const [k, t] of Object.entries(schema)) {
        const v = configOverrides[k];
        if (typeof v === t) (runConfig as Record<string, unknown>)[k] = v;
      }
    }

    const now = new Date().toISOString();
    const run: PipelineRun = {
      id: randomUUID(),
      goal,
      stage: "research_plan",
      mode: "augment",
      iteration: 0,
      maxIterations: runConfig.maxIterations,
      waves: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this._runConfigs.set(run.id, runConfig);
    this.pipelineStore.save(run);
    this.broadcast({ type: "pipeline:started", runId: run.id, goal });

    this.drive(run).catch((err) => {
      run.stage = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.updatedAt = new Date().toISOString();
      this.pipelineStore.save(run);
      this.broadcast({ type: "pipeline:failed", runId: run.id, error: run.error });
      this._runConfigs.delete(run.id);
    });

    return run;
  }

  list(): PipelineRun[] {
    return this.pipelineStore.list();
  }

  get(id: string): PipelineRun | null {
    return this.pipelineStore.get(id);
  }

  approve(runId: string): boolean {
    const resolver = this.approveResolvers.get(runId);
    if (!resolver) return false;
    this.approveResolvers.delete(runId);
    resolver();
    return true;
  }

  cancel(runId: string): boolean {
    const run = this.pipelineStore.get(runId);
    if (!run || run.stage === "done" || run.stage === "failed") return false;

    for (const taskId of run.taskIds) {
      this.scheduler.cancel(taskId);
    }

    this.emit(`cancel:${runId}`);
    this.pipelineStore.updateStage(runId, "failed", { error: "Cancelled by user" });
    this.broadcast({ type: "pipeline:cancelled", runId });
    return true;
  }

  private cfg(runId: string): PipelineConfig {
    return this._runConfigs.get(runId) ?? this.config;
  }

  private async drive(run: PipelineRun): Promise<void> {
    let ctx = getRepoContext(this.repoPath);
    while (run.stage !== "done" && run.stage !== "failed") {
      switch (run.stage) {
        case "research_plan":
          await this.doResearchPlan(run, ctx);
          break;
        case "waiting_approval":
          return; // doResearchPlan handles resumption
        case "decompose":
          await this.doDecompose(run, ctx);
          break;
        case "execute":
          await this.doExecute(run);
          break;
        case "verify":
          ctx = getRepoContext(this.repoPath); // refresh after execute modifies repo
          await this.doVerify(run, ctx);
          break;
      }
    }

    this._runConfigs.delete(run.id);
    if (run.stage === "done") {
      this.broadcast({ type: "pipeline:done", runId: run.id });
    }
  }

  private async doResearchPlan(run: PipelineRun, ctx: RepoContext): Promise<void> {
    const pipelineDir = join(this.repoPath, ".cc-pipeline");
    mkdirSync(pipelineDir, { recursive: true });

    // Detect mode
    try {
      const { stdout } = await exec("git log --oneline -1", { cwd: this.repoPath });
      run.mode = stdout.trim() ? "augment" : "greenfield";
    } catch {
      run.mode = "greenfield";
    }

    const modeInstructions = run.mode === "greenfield"
      ? `This is a NEW empty repository. You must design the architecture from scratch.\nCreate the initial project structure, choose frameworks, and define conventions.`
      : `This is an EXISTING repository. Study the codebase before proposing changes.\nPreserve existing patterns, conventions, and architecture unless the goal requires changes.`;

    const prompt = [
      `You are a senior software architect. Research the repository and create an implementation plan.`,
      ``,
      `## Goal`,
      run.goal,
      ``,
      `## Mode: ${run.mode}`,
      modeInstructions,
      ``,
      `## Repository Context`,
      `Language: ${ctx.language}`,
      `Files: ${ctx.fileCount}`,
      `Has tests: ${ctx.hasTests}`,
      ctx.dependencies ? `\n### Dependencies\n${ctx.dependencies}` : "",
      ctx.fileTree ? `\n### File Tree\n${ctx.fileTree}` : "",
      ``,
      `## Your Task`,
      `1. Read and understand the existing codebase (if augment mode)`,
      `2. Identify which files need to be created or modified`,
      `3. Write a structured plan to .cc-pipeline/plan.md with this format:`,
      ``,
      `### Plan Format (write to .cc-pipeline/plan.md):`,
      `# Implementation Plan`,
      `## Summary`,
      `[1-2 paragraph overview]`,
      `## Files to Create`,
      `- path/to/file.ts: description`,
      `## Files to Modify`,
      `- path/to/file.ts: what changes and why`,
      `## Waves (execution order)`,
      `### Wave 0: [name] (parallel)`,
      `- Task 1: description`,
      `- Task 2: description`,
      `### Wave 1: [name] (depends on wave 0)`,
      `- Task 3: description`,
      `## Risks`,
      `- [risk and mitigation]`,
      ``,
      `IMPORTANT: Tasks in the same wave MUST be independent (no shared files). ` +
      `Later waves can depend on earlier waves. Order waves so that types/interfaces come first, ` +
      `then implementations, then tests, then integration.`,
    ].join("\n");

    const cfg = this.cfg(run.id);
    const task = createTask(prompt, { timeout: cfg.metaTaskTimeout });
    await this.runner.run(task, this.repoPath, (event) => {
      this.broadcast({ type: "pipeline:research_plan:event", runId: run.id, ...event });
    });

    this.broadcast({ type: "pipeline:plan_ready", runId: run.id });

    if (!cfg.autoApprove) {
      this.pipelineStore.updateStage(run.id, "waiting_approval");
      run.stage = "waiting_approval";
      this.broadcast({ type: "pipeline:waiting_approval", runId: run.id });

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.approveResolvers.delete(run.id);
          this.removeListener(`cancel:${run.id}`, onCancel);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Plan approval timed out after 24h"));
        }, 24 * 60 * 60 * 1000);
        const onCancel = () => {
          cleanup();
          reject(new Error("Pipeline cancelled"));
        };
        this.once(`cancel:${run.id}`, onCancel);
        this.approveResolvers.set(run.id, () => { cleanup(); resolve(); });
      });
    }

    this.pipelineStore.updateStage(run.id, "decompose");
    run.stage = "decompose";
  }

  private async doDecompose(run: PipelineRun, ctx: RepoContext): Promise<void> {
    const planPath = join(this.repoPath, ".cc-pipeline", "plan.md");
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      planContent = run.goal;
    }

    const prompt = [
      `You are a task decomposition agent. Convert the plan into executable task prompts.`,
      ``,
      `## Plan`,
      planContent,
      ``,
      `## Repository`,
      `Language: ${ctx.language}`,
      `File count: ${ctx.fileCount}`,
      ``,
      `## Rules`,
      `1. Each task prompt must be a COMPLETE, SELF-CONTAINED instruction that a coding agent can execute.`,
      `2. Each task should modify at most 2-3 files. If a task touches more, split it.`,
      `3. Tasks in the same wave run in PARALLEL — they MUST NOT modify the same files.`,
      `4. Wave ordering: types/interfaces → implementations → tests → integration.`,
      `5. Each task prompt must be under 1800 characters (hard limit).`,
      `6. Include specific file paths in each task prompt.`,
      `7. If the repo is TypeScript, remind each task to use .js extensions in imports.`,
      ``,
      `## Output Format`,
      `Output ONLY a valid JSON object (no markdown fences, no explanation):`,
      `{`,
      `  "waves": [`,
      `    { "waveIndex": 0, "tasks": ["Create file src/types.ts with interfaces X and Y..."] },`,
      `    { "waveIndex": 1, "tasks": ["Implement function Z in src/lib.ts that uses types from wave 0..."] }`,
      `  ],`,
      `  "totalTasks": <number>`,
      `}`,
    ].join("\n");

    const task = createTask(prompt, { timeout: this.cfg(run.id).metaTaskTimeout });
    const result = await this.runner.run(task, this.repoPath, (event) => {
      this.broadcast({ type: "pipeline:decompose:event", runId: run.id, ...event });
    });

    const output = parseJsonFromOutput<DecomposeOutput>(
      result.output ?? "",
      (v): v is DecomposeOutput => Array.isArray((v as DecomposeOutput)?.waves),
    );

    const validated = validateWaves(output);
    const pipelineDir = join(this.repoPath, ".cc-pipeline");
    writeFileSync(join(pipelineDir, "tasks.json"), JSON.stringify(validated, null, 2));
    this._lastDecompose = validated;

    this.pipelineStore.updateStage(run.id, "execute");
    run.stage = "execute";
    this.broadcast({ type: "pipeline:decomposed", runId: run.id, waves: validated.waves.length, totalTasks: validated.totalTasks });
  }

  private async doExecute(run: PipelineRun): Promise<void> {
    const decomposed = this._lastDecompose
      ?? JSON.parse(readFileSync(join(this.repoPath, ".cc-pipeline", "tasks.json"), "utf-8")) as DecomposeOutput;
    const cfg = this.cfg(run.id);

    // Load plan for task context (truncate to keep prompts reasonable)
    let planContext = "";
    try {
      const plan = readFileSync(join(this.repoPath, ".cc-pipeline", "plan.md"), "utf-8");
      planContext = plan.length > 2000 ? plan.slice(0, 2000) + "\n...(truncated)" : plan;
    } catch { /* no plan file */ }

    for (const wave of decomposed.waves) {
      const submittedTasks: Task[] = [];
      for (const taskPrompt of wave.tasks) {
        const contextualPrompt = planContext
          ? `## Context\nYou are executing wave ${wave.waveIndex} of a multi-wave pipeline.\nRead .cc-pipeline/plan.md for the full implementation plan.\n\n## Your Task\n${taskPrompt}`
          : taskPrompt;
        const t = this.scheduler.submit(contextualPrompt, {
          timeout: cfg.codeTaskTimeout,
          maxBudget: cfg.codeTaskBudget,
          tags: [`pipeline:${run.id}`, `wave:${wave.waveIndex}`],
          allowLongPrompt: true,
        });
        submittedTasks.push(t);
        run.taskIds.push(t.id);
      }

      this.broadcast({ type: "pipeline:wave_started", runId: run.id, waveIndex: wave.waveIndex, taskCount: submittedTasks.length });

      const completed = await this.waitForTasks(submittedTasks.map((t) => t.id));

      const successCount = completed.filter((t) => t.status === "success").length;
      const waveResult: WaveResult = {
        waveIndex: wave.waveIndex,
        taskIds: submittedTasks.map((t) => t.id),
        successCount,
        failCount: completed.length - successCount,
      };
      run.waves.push(waveResult);
      this.pipelineStore.save(run);

      this.broadcast({ type: "pipeline:wave_done", runId: run.id, ...waveResult });
    }

    this.pipelineStore.updateStage(run.id, "verify");
    run.stage = "verify";
  }

  private async doVerify(run: PipelineRun, ctx: RepoContext): Promise<void> {
    const verifyCommands = ctx.language === "typescript"
      ? `1. Run: npx tsc --noEmit 2>&1\n2. Run: npm test 2>&1`
      : ctx.language === "python"
        ? `1. Run: python -m pytest 2>&1 (or the project's test command)`
        : `1. Run: npm test 2>&1 (if package.json exists)`;

    const prompt = [
      `You are a verification agent. Run build and test commands, then report results.`,
      ``,
      `## Commands to Run`,
      verifyCommands,
      ``,
      `## Analysis`,
      `For EACH error found:`,
      `- Extract the exact file path and line number`,
      `- Identify the error type (type error, missing import, test failure, etc.)`,
      `- Write a specific, actionable description of what needs to be fixed`,
      ``,
      `## Output Format`,
      `Output ONLY a valid JSON object (no markdown fences):`,
      `{`,
      `  "tscClean": true/false,`,
      `  "testsPass": true/false,`,
      `  "errors": [`,
      `    "src/foo.ts:42 - TS2304: Cannot find name 'Bar'. Fix: add import { Bar } from './bar.js'",`,
      `    "src/foo.test.ts:15 - AssertionError: expected 3 but got 2. Fix: update calculation in src/foo.ts:28"`,
      `  ],`,
      `  "verdict": "pass" or "fail"`,
      `}`,
      ``,
      `IMPORTANT: Each error string must be specific enough that a developer can fix it without additional context.`,
      `Include file paths, line numbers, and the exact fix needed.`,
    ].join("\n");

    const task = createTask(prompt, { timeout: this.cfg(run.id).metaTaskTimeout });
    const result = await this.runner.run(task, this.repoPath, (event) => {
      this.broadcast({ type: "pipeline:verify:event", runId: run.id, ...event });
    });

    const output = parseJsonFromOutput<VerifyOutput>(
      result.output ?? "",
      (v): v is VerifyOutput => typeof (v as VerifyOutput)?.verdict === "string",
    );

    // Persist verify results for dashboard visibility
    if (!run.verifyResults) run.verifyResults = [];
    run.verifyResults.push(output);
    this.pipelineStore.save(run);

    if (output.verdict === "pass") {
      this.pipelineStore.updateStage(run.id, "done");
      run.stage = "done";
      this.broadcast({ type: "pipeline:verified", runId: run.id, verdict: "pass" });
    } else {
      run.iteration++;
      const cfg = this.cfg(run.id);

      // Dead-loop detection: same errors as last verify → agent can't fix this
      const prevErrors = run.verifyResults && run.verifyResults.length >= 2
        ? run.verifyResults[run.verifyResults.length - 2]?.errors
        : undefined;
      const sameErrors = prevErrors && JSON.stringify(prevErrors) === JSON.stringify(output.errors);

      // Budget check: estimate total spent from completed tasks
      let totalSpent = 0;
      for (const taskId of run.taskIds) {
        const t = this.scheduler.getTask(taskId);
        if (t?.costUsd) totalSpent += t.costUsd;
      }
      const budgetExhausted = cfg.totalBudget > 0 && totalSpent + cfg.codeTaskBudget > cfg.totalBudget;

      // Hard cap as safety valve
      const iterationCap = run.iteration >= cfg.maxIterations;

      if (sameErrors || budgetExhausted || iterationCap) {
        const reason = sameErrors ? "same errors repeated (dead loop)"
          : budgetExhausted ? `budget exhausted ($${totalSpent.toFixed(2)} spent of $${cfg.totalBudget})`
          : `max iterations reached (${cfg.maxIterations})`;
        run.error = `Verification failed: ${reason}. Errors: ${output.errors.join("; ")}`;
        this.pipelineStore.updateStage(run.id, "failed", { error: run.error, iteration: run.iteration });
        run.stage = "failed";
        this.broadcast({ type: "pipeline:failed", runId: run.id, error: run.error });
      } else {
        // Generate fix tasks from verify errors instead of re-running original tasks
        this._lastDecompose = this.buildFixTasks(output.errors, run.iteration);
        const pipelineDir = join(this.repoPath, ".cc-pipeline");
        writeFileSync(join(pipelineDir, "tasks.json"), JSON.stringify(this._lastDecompose, null, 2));
        this.pipelineStore.updateStage(run.id, "execute", { iteration: run.iteration });
        run.stage = "execute";
        this.broadcast({ type: "pipeline:retry", runId: run.id, iteration: run.iteration, errors: output.errors, totalSpent });
      }
    }
  }

  private buildFixTasks(errors: string[], iteration: number): DecomposeOutput {
    // Group errors by file to minimize parallel conflicts
    const byFile = new Map<string, string[]>();
    for (const err of errors) {
      const fileMatch = err.match(/^([\w./\\-]+\.\w+)/);
      const file = fileMatch?.[1] ?? "unknown";
      const list = byFile.get(file) ?? [];
      list.push(err);
      byFile.set(file, list);
    }

    const tasks: string[] = [];
    for (const [file, fileErrors] of byFile) {
      const errorList = fileErrors.map(e => `- ${e}`).join("\n");
      tasks.push(
        `Fix the following errors in ${file} (iteration ${iteration}):\n${errorList}\n\n` +
        `Read the file, understand the context, fix each error, and run the type checker to verify your fix.`
      );
    }

    // If no file-specific errors, create a single catch-all fix task
    if (tasks.length === 0) {
      tasks.push(
        `Fix verification errors (iteration ${iteration}):\n${errors.map(e => `- ${e}`).join("\n")}\n\n` +
        `Run the build and tests, identify the root cause, and fix it.`
      );
    }

    return { waves: [{ waveIndex: 0, tasks }], totalTasks: tasks.length };
  }

  private async waitForTasks(taskIds: string[]): Promise<Task[]> {
    const results: Task[] = [];
    const pending = new Set(taskIds);

    while (pending.size > 0) {
      for (const id of pending) {
        const task = this.scheduler.getTask(id);
        if (!task) {
          pending.delete(id);
          continue;
        }
        if (task.status === "success" || task.status === "failed" || task.status === "timeout" || task.status === "cancelled") {
          results.push(task);
          pending.delete(id);
        }
      }
      if (pending.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    return results;
  }
}

/** Extract file paths mentioned in a task prompt (e.g., src/foo.ts, lib/bar.js) */
export function extractFilePaths(prompt: string): string[] {
  const matches = prompt.match(/(?:^|\s|['"`])((?:[\w.-]+\/)*[\w.-]+\.\w{1,4})(?=[\s,'"`):;]|$)/gm);
  if (!matches) return [];
  const paths = new Set<string>();
  for (const m of matches) {
    const p = m.trim().replace(/^['"`]|['"`]$/g, "");
    // Skip common false positives
    if (/^\d/.test(p) || /^(http|https|ftp):/.test(p)) continue;
    if (/\.(md|txt|json|yaml|yml|toml|lock|log)$/.test(p)) continue; // config/docs not conflicts
    paths.add(p);
  }
  return [...paths];
}

/** Validate wave decomposition: move tasks with file conflicts to later waves */
export function validateWaves(decomposed: DecomposeOutput): DecomposeOutput {
  const newWaves: { waveIndex: number; tasks: string[] }[] = [];
  let nextWaveOverflow: string[] = [];

  for (const wave of decomposed.waves) {
    const currentTasks = [...wave.tasks, ...nextWaveOverflow];
    nextWaveOverflow = [];
    const keep: string[] = [];
    const usedFiles = new Map<string, number>(); // file → first task index in keep

    for (const task of currentTasks) {
      const files = extractFilePaths(task);
      let hasConflict = false;
      for (const f of files) {
        if (usedFiles.has(f)) {
          hasConflict = true;
          break;
        }
      }
      if (hasConflict) {
        nextWaveOverflow.push(task);
      } else {
        for (const f of files) usedFiles.set(f, keep.length);
        keep.push(task);
      }
    }

    if (keep.length > 0) {
      newWaves.push({ waveIndex: newWaves.length, tasks: keep });
    }
  }

  // Flush remaining overflow tasks into additional waves
  while (nextWaveOverflow.length > 0) {
    const batch = nextWaveOverflow;
    nextWaveOverflow = [];
    const keep: string[] = [];
    const usedFiles = new Map<string, number>();

    for (const task of batch) {
      const files = extractFilePaths(task);
      let hasConflict = false;
      for (const f of files) {
        if (usedFiles.has(f)) { hasConflict = true; break; }
      }
      if (hasConflict) {
        nextWaveOverflow.push(task);
      } else {
        for (const f of files) usedFiles.set(f, keep.length);
        keep.push(task);
      }
    }

    if (keep.length > 0) {
      newWaves.push({ waveIndex: newWaves.length, tasks: keep });
    } else {
      // All remaining tasks conflict with each other — serialize them
      for (const task of batch) {
        newWaves.push({ waveIndex: newWaves.length, tasks: [task] });
      }
      break;
    }
  }

  const totalTasks = newWaves.reduce((sum, w) => sum + w.tasks.length, 0);
  return { waves: newWaves, totalTasks };
}

function parseJsonFromOutput<T>(output: string, validate: (v: unknown) => v is T): T {
  // Try 1: direct parse
  try {
    const parsed = JSON.parse(output);
    if (validate(parsed)) return parsed;
  } catch {
    // continue
  }

  // Try 2: extract between outermost braces
  const braceMatch = output.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (validate(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  // Try 3: extract from ```json fences
  const fenceMatch = output.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (validate(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  throw new Error(`Failed to parse JSON from output: ${output.slice(0, 200)}`);
}
