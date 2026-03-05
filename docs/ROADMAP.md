# cc-manager Roadmap

> **Updated**: 2026-03-05 | **Status**: Active

## Current State (v0.1.7)

| Metric | Value |
|--------|-------|
| Core modules | 13 (types, logger, store, worktree-pool, agent-runner, scheduler, server, cli, index, pipeline, pipeline-types, pipeline-store, task-classifier) |
| LOC | 4,924 |
| Tests | 372 pass, 0 fail |
| Features shipped | Priority queue, worktree isolation, SQLite/WAL, SSE, cross-agent review, squash merge, cost tracking, 5-stage pipeline, DAG dispatch, staged rebase, task classifier, model escalation, GPT-5.4 routing, session resume, empty commit detection |
| Agent types | 4 (claude, claude-sdk, codex, generic) |
| API endpoints | 20+ |
| Self-hosting commit rate | 43% (NOT WORKING — requires manual fixes) |

### What works well
- Worktree pool (create/acquire/release/merge with conflict detection)
- Event-driven scheduler with priority queue, retry, and model escalation
- Cross-agent diff review before merge (Claude codes → Codex reviews)
- Squash merge with review persisted to SQLite + staged rebase
- Real-time SSE dashboard + CLI client
- 5-stage autonomous pipeline (research→decompose→execute→verify)
- Dependency DAG dispatch with wave planning
- Task classifier routing (quick/standard/deep → model/agent/contextProfile)
- Empty commit detection (v0.1.7) — no more silent success

### What's NOT working (honest assessment)
1. **Flywheel loop** — 2 pipeline runs, 43-50% commit rate, 0% unattended merge
2. **Complex file integration** — scheduler.ts (618 LOC) tasks always fail (0/4 across 2 runs)
3. **Failure diagnosis** — only basic error injection, no structured parsing
4. **Agent self-evolution** — Pillar 4 not started

The flywheel is the #1 blocker. Until agents can reliably produce mergeable code, the self-hosting loop is aspirational.

---

## Competitive Landscape (2026-03)

Key insight: Claude Code now has built-in Agent Teams, Hooks, and Worktrees. cc-manager should **not** reinvent coordination — it should be the **orchestration layer above** individual agent runtimes.

| Tool | Strength | cc-manager differentiator |
|------|----------|--------------------------|
| Claude Code Agent Teams | Built-in multi-agent + shared tasks | cc-manager adds wave planning, CI feedback, multi-provider |
| Gas Town (steveyegge) | Persistent work state (Beads), 20-30 agents | cc-manager adds dependency analysis, failure diagnosis |
| Composio Orchestrator | CI auto-fix loop, 30 agents, MCP gateway | cc-manager adds wave planning, multi-provider flexibility |
| Emdash | 22+ agents, issue integration, Docker isolation | cc-manager adds staged merging, failure diagnosis |
| Vibe Kanban | Visual kanban, 10+ agents, built-in dev env | cc-manager adds programmatic API, wave planning |

**cc-manager's moat**: Nobody else does dependency-aware wave planning + staged merging + automated failure diagnosis. These three together solve the isolation paradox.

---

## Roadmap: 3 Phases

### Phase 1: Core Loop (the moat)

> Goal: Solve the isolation paradox. Get auto-merge rate from ~50% to 80%+.

| # | Feature | File | LOC | Priority |
|---|---------|------|-----|----------|
| 1 | **Wave planner** — analyze task deps, topological sort into waves | `src/wave-planner.ts` | ~160 | P0 |
| 2 | **Staged merger** — merge completed → rebase active → next wave | `src/staged-merger.ts` | ~140 | P0 |
| 3 | **Failure diagnoser** — parse TSC errors → isolation paradox detection → retry prompt | `src/failure-diagnoser.ts` | ~170 | P0 |
| 4 | **Pipeline** — connects wave → dispatch → merge → diagnose | `src/pipeline.ts` | ~180 | P0 |
| 5 | **CI feedback** — on TSC/test fail, inject errors into agent retry context | `src/agent-runner.ts` MODIFY | ~50 | P0 |
| 6 | **Fix listTasks()** — merge memory + SQLite reads | `src/store.ts` MODIFY | ~20 | P1 |

**How wave planning works**:
```
Tasks: [A: "create types.ts", B: "import from types.ts", C: "add tests"]
           ↓ analyzeDeps()
Edges: [A→B (B consumes types.ts created by A)]
           ↓ planWaves()
Wave 0: [A, C]  (independent, run parallel)
Wave 1: [B]     (depends on A, runs after wave 0 merges)
```

**How staged merging works**:
```
Wave 0 starts: A and C run in parallel worktrees
  A completes → mergeOne(A) → rebase C's worktree onto updated main
  C completes → mergeOne(C)
Wave 1 starts: B runs, can see A's types.ts (already merged)
  B completes → mergeOne(B)
```

**Acceptance criteria**:
- [ ] Wave planner correctly groups independent tasks
- [ ] Staged merger merges immediately and rebases active worktrees
- [ ] Failure diagnoser detects isolation paradox (missing module/type/export)
- [ ] Pipeline orchestrates full wave→dispatch→merge→diagnose loop
- [ ] Auto-merge rate improves measurably on a 5-task batch

### Phase 2: Robustness

> Goal: Handle failures gracefully, monitor intelligently, recover automatically.

| # | Feature | File | LOC | Priority |
|---|---------|------|-----|----------|
| 7 | **Stall detection** — monitor output activity, not wall-clock | `src/agent-runner.ts` MODIFY | ~30 | P1 |
| 8 | **JSONL monitor** — read Claude session files for progress | `src/jsonl-monitor.ts` | ~100 | P1 |
| 9 | **Context recovery** — checkpoint task state, resume on failure | `src/checkpoint.ts` | ~100 | P1 |
| 10 | **Worktree pre-warm** — reserve pool, zero-latency claim | `src/worktree-pool.ts` MODIFY | ~50 | P2 |
| 11 | **Promise-based lock** — replace 10ms spin with async queue | `src/worktree-pool.ts` MODIFY | ~30 | P2 |
| 12 | **Hooks integration** — leverage CC hooks for quality gates | `src/hooks.ts` | ~80 | P1 |

**Hooks integration** (leveraging Claude Code's native hook system):
```json
{
  "hooks": {
    "TaskCompleted": [{
      "type": "command",
      "command": "npx tsc --noEmit && npm test"
    }],
    "Stop": [{
      "type": "prompt",
      "prompt": "Verify all acceptance criteria are met"
    }]
  }
}
```

**Acceptance criteria**:
- [ ] Stalled agents detected within 30s of last output
- [ ] Session JSONL progress visible in dashboard
- [ ] Failed tasks resume from checkpoint with previous context
- [ ] Worktree acquire latency < 100ms (pre-warmed pool)

### Phase 3: Scale + Intelligence

> Goal: Multi-provider flexibility, smart routing, learning from history.

| # | Feature | File | LOC | Priority |
|---|---------|------|-----|----------|
| 13 | **Provider registry** — declarative agent plugin system | `src/provider-registry.ts` | ~150 | P2 |
| 14 | **Smart router** — route by complexity, history, budget | `src/router.ts` | ~150 | P2 |
| 15 | **Execution memory** — store patterns, feed back to routing | `src/memory.ts` | ~100 | P2 |
| 16 | **GitHub Issues integration** — issues → tasks (auto-dispatch) | `src/integrations/github.ts` | ~150 | P2 |
| 17 | **Attempt model** — multiple tries per task, compare diffs | `src/scheduler.ts` MODIFY | ~80 | P3 |
| 18 | **Dashboard v2** — kanban lanes, cost charts, wave visualization | `src/web/` MODIFY | ~200 | P3 |

**Provider registry**:
```typescript
interface AgentProvider {
  name: string;
  detect(): Promise<boolean>;       // is this agent installed?
  run(task, cwd): Promise<Result>;  // execute task
  review(diff): Promise<Review>;    // review code
  cost(tokens): number;             // estimate cost
  capabilities: { maxContext, speed, supportsStreaming };
}
```

**Acceptance criteria**:
- [ ] New agent CLI auto-detected and registered
- [ ] Tasks route to best agent based on complexity + history
- [ ] GitHub Issues with label auto-convert to tasks
- [ ] Memory stores success/failure patterns per task type

---

## Summary

| Phase | New files | Modified | Est. LOC | Key metric |
|-------|-----------|----------|----------|------------|
| 1: Core Loop | 4 | 2 | ~720 | Auto-merge rate 50%→80% |
| 2: Robustness | 3 | 3 | ~390 | Recovery rate, stall detection |
| 3: Scale | 4 | 2 | ~830 | Multi-provider, smart routing |
| **Total** | **11** | **7** | **~1,940** | 3,738→~5,700 LOC |

**Critical path**: Phase 1 (#1-5) → Phase 2 (#7,8,12) → Phase 3 (#13,14)

Phase 1 is the moat. Ship it first, measure auto-merge rate, then iterate.

---

## Design Principles

1. **Leverage, don't reinvent** — Claude Code has Agent Teams, Hooks, Worktrees. Use them. cc-manager adds the orchestration layer above.
2. **Merge early, merge often** — Staged merging is the core innovation. Every completed task merges immediately, every active worktree rebases.
3. **Diagnose, don't retry blindly** — Parse errors structurally. Tell the agent exactly what's wrong and how to fix it.
4. **One file per task** — Prevents merge conflicts. Creation (~100% success) > modification (~70% success).
5. **Simple prompts** — 3-4 sentences max. One clear objective per task.
