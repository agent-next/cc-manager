import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import path from "node:path";
import type { WorkerInfo } from "./types.js";
import { log } from "./logger.js";

/** Internal per-worker tracking not stored on WorkerInfo itself. */
interface WorkerMeta {
  busySince?: number; // epoch ms when worker became busy
  taskCount: number;  // lifetime count of tasks processed by this worker
}

/** Extended status object returned by getStatus(), adding uptime and taskCount. */
export type WorkerStatus = WorkerInfo & { uptime?: number; taskCount: number };

const exec = promisify(execFile);

export class WorktreePool {
  private workers: Map<string, WorkerInfo> = new Map();
  private workerMeta: Map<string, WorkerMeta> = new Map();
  private lock = false;

  constructor(
    private repoPath: string,
    private poolSize: number,
  ) {
    this.repoPath = path.resolve(repoPath);
  }

  async init(): Promise<void> {
    const initStart = Date.now();
    const wtDir = path.join(this.repoPath, ".worktrees");
    mkdirSync(wtDir, { recursive: true });

    // Do NOT checkout main here — it changes the repo's working tree HEAD,
    // which corrupts the repo when --repo points to the current directory.

    const worktreePromises = Array.from({ length: this.poolSize }, async (_, i) => {
      const name = `worker-${i}`;
      const workerPath = path.join(wtDir, name);
      const branch = `worker/${name}`;

      if (existsSync(workerPath)) {
        await this.resetWorktree({ name, path: workerPath, branch, busy: false });
      } else {
        await this.git("branch", "-D", branch).catch(() => {});
        try {
          const r = await this.git("worktree", "add", "-b", branch, workerPath, "main").catch(() => null);
          if (!r) {
            await this.git("worktree", "add", workerPath, branch);
          }
        } catch (err) {
          log("error", "[pool] git worktree add failed", { name, workerPath, err: String(err) });
          throw new Error(`Failed to create worktree '${name}' at '${workerPath}': ${String(err)}`);
        }
      }

      this.workers.set(name, { name, path: workerPath, branch, busy: false });
      this.workerMeta.set(name, { taskCount: 0 });
    });

    const results = await Promise.allSettled(worktreePromises);
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        log("error", "[pool] failed to init worker", { worker: `worker-${i}`, err: String(result.reason) });
      }
    });

    const initMs = Date.now() - initStart;
    log("info", "[pool] worktrees ready", { count: this.workers.size, initMs });
  }

  async acquire(): Promise<WorkerInfo | null> {
    await this.waitLock();
    this.lock = true;
    try {
      for (const w of this.workers.values()) {
        if (!w.busy) {
          w.busy = true;
          const meta = this.workerMeta.get(w.name) ?? { taskCount: 0 };
          meta.busySince = Date.now();
          meta.taskCount += 1;
          this.workerMeta.set(w.name, meta);
          try {
            await this.resetWorktree(w);
          } catch (err) {
            log("error", "[pool] acquire: failed to reset worktree, skipping", { worker: w.name, err: String(err) });
            w.busy = false;
            continue;
          }
          return w;
        }
      }
      return null;
    } finally {
      this.lock = false;
    }
  }

  async release(name: string, merge: boolean, taskId?: string): Promise<{ merged: boolean; conflictFiles?: string[] }> {
    await this.waitLock();
    this.lock = true;
    try {
      const w = this.workers.get(name);
      if (!w) return { merged: false };

      let result: { merged: boolean; conflictFiles?: string[] } = { merged: true };
      if (merge) {
        try {
          result = await this.mergeToMain(w, taskId);
        } catch (err) {
          log("error", "[pool] release: mergeToMain failed", { worker: w.name, err: String(err) });
          throw new Error(`Failed to merge worktree '${w.name}' to main: ${String(err)}`);
        }
      }

      w.busy = false;
      w.currentTask = undefined;
      const meta = this.workerMeta.get(w.name);
      if (meta) meta.busySince = undefined;
      return result;
    } finally {
      this.lock = false;
    }
  }

  async isHealthy(name: string): Promise<boolean> {
    const w = this.workers.get(name);
    if (!w || !existsSync(w.path)) return false;
    try {
      await this.gitIn(w.path, "rev-parse", "--git-dir");
      return true;
    } catch {
      return false;
    }
  }

  private async resetWorktree(w: WorkerInfo): Promise<void> {
    await this.gitIn(w.path, "checkout", w.branch);

    // Try origin/main first (picks up upstream changes), fall back to local main.
    // Let failures throw — a dirty worktree must not be reused.
    try {
      await this.gitIn(w.path, "reset", "--hard", "origin/main");
    } catch {
      await this.gitIn(w.path, "reset", "--hard", "main");
    }

    try {
      // Exclude node_modules from clean — we symlink it for build verification
      await this.gitIn(w.path, "clean", "-fdx", "-e", "node_modules");
    } catch (err) {
      log("warn", "[pool] clean failed (non-fatal)", { worker: w.name, err: String(err) });
    }

    // Ensure node_modules symlinks exist so agents can run npx tsc
    this.ensureNodeModulesSymlink(w.path);
  }

  /** Symlink node_modules from the main repo into the worktree so build tools work. */
  private ensureNodeModulesSymlink(worktreePath: string): void {
    const mainNM = path.join(this.repoPath, "v1", "node_modules");
    const wtNM = path.join(worktreePath, "v1", "node_modules");

    if (!existsSync(mainNM)) return;

    const wtV1 = path.join(worktreePath, "v1");
    if (!existsSync(wtV1)) mkdirSync(wtV1, { recursive: true });

    try {
      const stat = lstatSync(wtNM);
      if (stat.isSymbolicLink()) return;
    } catch {
      // Does not exist — create it
    }

    try {
      symlinkSync(mainNM, wtNM, "dir");
      log("debug", "[pool] symlinked node_modules", { worktree: worktreePath });
    } catch (err) {
      log("warn", "[pool] failed to symlink node_modules", { worktree: worktreePath, err: String(err) });
    }
  }

  private async mergeToMain(w: WorkerInfo, taskId?: string): Promise<{ merged: boolean; conflictFiles?: string[] }> {
    // Check if branch has new commits vs main
    const { stdout: diff } = await this.git("log", `main..${w.branch}`, "--oneline");
    if (!diff.trim()) return { merged: true };

    log("info", "[pool] merging branch", { branch: w.branch, target: "main", taskId });

    // When taskId is provided, use squash merge to keep main clean.
    // Otherwise fall back to the legacy ff/merge behavior for backward compat.
    if (taskId) {
      return this.squashMergeToMain(w, taskId, diff.trim());
    }

    // Legacy path: fast-forward or merge commit
    try {
      await this.git("fetch", ".", `${w.branch}:main`);
    } catch {
      // Non-fast-forward — merge in worktree via temp branch (can't checkout main directly)
      const tmpBranch = `_merge_legacy_${Date.now()}`;
      try {
        const mainSha = (await this.git("rev-parse", "main")).stdout.trim();
        await this.gitIn(w.path, "checkout", "-b", tmpBranch, mainSha);
        await this.gitIn(w.path, "merge", w.branch, "--no-edit");
        const mergedSha = (await this.gitIn(w.path, "rev-parse", "HEAD")).stdout.trim();
        await this.git("update-ref", "refs/heads/main", mergedSha);
      } catch {
        await this.cleanupTmpBranch(w, tmpBranch);
        return this.handleMergeConflict(w);
      }
      await this.cleanupTmpBranch(w, tmpBranch);
    }

    await this.resetWorktree(w);
    return { merged: true };
  }

  private async squashMergeToMain(
    w: WorkerInfo,
    taskId: string,
    logOutput: string,
  ): Promise<{ merged: boolean; conflictFiles?: string[] }> {
    // Use the most recent commit message as summary (git log outputs newest first)
    const firstLine = logOutput.split("\n")[0] ?? "";
    const rawSummary = firstLine.replace(/^[0-9a-f]+\s+/, "");
    const summary = rawSummary.length <= 72
      ? rawSummary
      : rawSummary.slice(0, 72).replace(/\s+\S*$/, "");

    // Cache branch tip before merge — avoids redundant rev-parse after
    const branchTip = (await this.gitIn(w.path, "rev-parse", w.branch)).stdout.trim();

    // Can't `checkout main` in a worktree (git refuses if main is checked out
    // by the main repo). Instead, create a temporary branch from main, squash
    // there, then update the main ref via update-ref.
    const tmpBranch = `_squash_${taskId}_${Date.now()}`;
    try {
      const mainSha = (await this.git("rev-parse", "main")).stdout.trim();
      await this.gitIn(w.path, "checkout", "-b", tmpBranch, mainSha);
      await this.gitIn(w.path, "merge", "--squash", w.branch);
      await this.gitIn(w.path, "commit", "-m", `task(${taskId}): ${summary}`);
      const squashedSha = (await this.gitIn(w.path, "rev-parse", "HEAD")).stdout.trim();
      await this.git("update-ref", "refs/heads/main", squashedSha);
      // Preserve the full agent commit history only after successful merge
      await this.git("update-ref", `refs/tasks/${taskId}`, branchTip);
    } catch {
      await this.cleanupTmpBranch(w, tmpBranch);
      return this.handleMergeConflict(w);
    }

    await this.cleanupTmpBranch(w, tmpBranch);
    await this.resetWorktree(w);
    return { merged: true };
  }

  private async cleanupTmpBranch(w: WorkerInfo, tmpBranch: string): Promise<void> {
    await this.gitIn(w.path, "checkout", w.branch).catch(() => {});
    await this.git("branch", "-D", tmpBranch).catch(() => {});
  }

  private async handleMergeConflict(w: WorkerInfo): Promise<{ merged: boolean; conflictFiles?: string[] }> {
    let conflictFiles: string[] = [];
    try {
      const { stdout } = await this.gitIn(w.path, "diff", "--name-only", "--diff-filter=U");
      conflictFiles = stdout.trim().split("\n").filter(Boolean);
    } catch {}

    log("warn", "[pool] merge conflict, aborting", { branch: w.branch });
    await this.gitIn(w.path, "merge", "--abort").catch(() => {});
    await this.gitIn(w.path, "checkout", w.branch).catch(() => {});
    return { merged: false, conflictFiles };
  }

  get available(): number {
    let n = 0;
    for (const w of this.workers.values()) if (!w.busy) n++;
    return n;
  }

  get busy(): number {
    return this.workers.size - this.available;
  }

  /**
   * Look up a worker by its name. Returns undefined if not found.
   */
  getWorker(name: string): WorkerInfo | undefined {
    return this.workers.get(name);
  }

  /**
   * Find the worker currently running the given task ID.
   * Returns undefined if no worker is handling that task.
   */
  getWorkerByTask(taskId: string): WorkerInfo | undefined {
    for (const w of this.workers.values()) {
      if (w.currentTask === taskId) return w;
    }
    return undefined;
  }

  /**
   * Returns true if the worker has been continuously busy for longer than
   * maxAgeMs milliseconds — a signal that it may be stuck.
   */
  isStale(worker: WorkerInfo, maxAgeMs: number): boolean {
    if (!worker.busy) return false;
    const meta = this.workerMeta.get(worker.name);
    if (!meta?.busySince) return false;
    return Date.now() - meta.busySince > maxAgeMs;
  }

  /**
   * Forcefully releases a stuck worker: attempts to kill its process (if a
   * PID was associated via the `pid` field on WorkerInfo), resets the git
   * worktree to a clean state, and marks the worker as available again.
   */
  async forceRelease(workerName: string): Promise<void> {
    await this.waitLock();
    this.lock = true;
    try {
      const w = this.workers.get(workerName);
      if (!w) {
        log("warn", "[pool] forceRelease: unknown worker", { workerName });
        return;
      }

      // Best-effort: kill the worker's process group so orphaned subprocesses
      // are also terminated.  We use the PGID derived from the stored PID so
      // that we don't accidentally kill unrelated processes.
      const pid = (w as WorkerInfo & { pid?: number }).pid;
      if (pid) {
        try {
          execFileSync("kill", ["-9", String(pid)]);
          log("info", "[pool] forceRelease: killed process", { workerName, pid });
        } catch {
          // Process may have already exited — that's fine.
        }
        delete (w as WorkerInfo & { pid?: number }).pid;
      }

      // Reset the worktree to a clean state so it can be reused.
      await this.resetWorktree(w);

      w.busy = false;
      w.currentTask = undefined;
      const meta = this.workerMeta.get(w.name);
      if (meta) meta.busySince = undefined;

      log("info", "[pool] forceRelease: worker freed", { workerName });
    } finally {
      this.lock = false;
    }
  }

  /**
   * Returns the status of every worker, enriched with:
   *  - `uptime`: milliseconds the worker has been continuously busy (undefined if idle)
   *  - `taskCount`: total number of tasks the worker has processed since init
   */
  getStatus(): WorkerStatus[] {
    const now = Date.now();
    return [...this.workers.values()].map((w) => {
      const meta = this.workerMeta.get(w.name) ?? { taskCount: 0 };
      const uptime = meta.busySince !== undefined ? now - meta.busySince : undefined;
      return { ...w, uptime, taskCount: meta.taskCount };
    });
  }

  getWorkerStats(): { total: number; busy: number; available: number; stale: number } {
    const STALE_MS = 5 * 60 * 1000; // 5 minutes
    let busy = 0;
    let stale = 0;
    for (const w of this.workers.values()) {
      if (w.busy) {
        busy++;
        if (this.isStale(w, STALE_MS)) stale++;
      }
    }
    const total = this.workers.size;
    return { total, busy, available: total - busy, stale };
  }

  private async git(...args: string[]) {
    return exec("git", args, { cwd: this.repoPath });
  }

  private async gitIn(dir: string, ...args: string[]) {
    return exec("git", args, { cwd: dir });
  }

  private async waitLock(): Promise<void> {
    while (this.lock) await new Promise((r) => setTimeout(r, 10));
  }
}
