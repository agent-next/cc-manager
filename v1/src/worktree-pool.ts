import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { WorkerInfo } from "./types.js";
import { log } from "./logger.js";

const exec = promisify(execFile);

export class WorktreePool {
  private workers: Map<string, WorkerInfo> = new Map();
  private lock = false;

  constructor(
    private repoPath: string,
    private poolSize: number,
  ) {
    this.repoPath = path.resolve(repoPath);
  }

  async init(): Promise<void> {
    const wtDir = path.join(this.repoPath, ".worktrees");
    mkdirSync(wtDir, { recursive: true });

    await this.git("checkout", "main").catch(() => {});

    for (let i = 0; i < this.poolSize; i++) {
      const name = `worker-${i}`;
      const workerPath = path.join(wtDir, name);
      const branch = `worker/${name}`;

      if (existsSync(workerPath)) {
        await this.resetWorktree({ name, path: workerPath, branch, busy: false });
      } else {
        await this.git("branch", "-D", branch).catch(() => {});
        const r = await this.git("worktree", "add", "-b", branch, workerPath, "main").catch(() => null);
        if (!r) {
          await this.git("worktree", "add", workerPath, branch).catch(() => {});
        }
      }

      this.workers.set(name, { name, path: workerPath, branch, busy: false });
    }

    log("info", "[pool] worktrees ready", { count: this.workers.size });
  }

  async acquire(): Promise<WorkerInfo | null> {
    await this.waitLock();
    this.lock = true;
    try {
      for (const w of this.workers.values()) {
        if (!w.busy) {
          w.busy = true;
          await this.resetWorktree(w);
          return w;
        }
      }
      return null;
    } finally {
      this.lock = false;
    }
  }

  async release(name: string, merge: boolean): Promise<{ merged: boolean; conflictFiles?: string[] }> {
    await this.waitLock();
    this.lock = true;
    try {
      const w = this.workers.get(name);
      if (!w) return { merged: false };

      let result: { merged: boolean; conflictFiles?: string[] } = { merged: true };
      if (merge) {
        result = await this.mergeToMain(w);
      }

      w.busy = false;
      w.currentTask = undefined;
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
    try {
      await this.gitIn(w.path, "checkout", w.branch);
    } catch (err) {
      log("error", "[pool] checkout failed", { worker: w.name, err: String(err) });
    }

    // Try origin/main first (picks up upstream changes), fall back to local main
    try {
      await this.gitIn(w.path, "reset", "--hard", "origin/main");
    } catch {
      try {
        await this.gitIn(w.path, "reset", "--hard", "main");
      } catch (err) {
        log("error", "[pool] reset failed", { worker: w.name, err: String(err) });
      }
    }

    try {
      await this.gitIn(w.path, "clean", "-fdx");
    } catch (err) {
      log("error", "[pool] clean failed", { worker: w.name, err: String(err) });
    }
  }

  private async mergeToMain(w: WorkerInfo): Promise<{ merged: boolean; conflictFiles?: string[] }> {
    // Check if branch has new commits vs main
    const { stdout: diff } = await this.git("log", `main..${w.branch}`, "--oneline");
    if (!diff.trim()) return { merged: true };

    log("info", "[pool] merging branch", { branch: w.branch, target: "main" });

    // Merge without checking out — stay on main
    try {
      await this.git("merge", w.branch, "--no-edit");
    } catch {
      // Collect conflicting file names before aborting
      let conflictFiles: string[] = [];
      try {
        const { stdout } = await this.git("diff", "--name-only", "--diff-filter=U");
        conflictFiles = stdout.trim().split("\n").filter(Boolean);
      } catch {}

      log("warn", "[pool] merge conflict, aborting", { branch: w.branch });
      await this.git("merge", "--abort").catch(() => {});
      return { merged: false, conflictFiles };
    }

    // Reset worktree to latest main
    await this.resetWorktree(w);
    return { merged: true };
  }

  get available(): number {
    let n = 0;
    for (const w of this.workers.values()) if (!w.busy) n++;
    return n;
  }

  get busy(): number {
    return this.workers.size - this.available;
  }

  getStatus(): WorkerInfo[] {
    return [...this.workers.values()];
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
