# Agent Flywheel Design

CC-Manager's product direction is to move from simple queue execution to a self-improving orchestration loop.

## 1. Core Thesis

Model quality is improving quickly. The orchestration layer must keep pace by doing more than dispatching prompts.

The goal:

- turn one-shot task execution into a repeatable operating system
- increase success rates through structured feedback
- scale parallel execution without losing merge safety or budget control

## 2. Flywheel Loop

The flywheel has four stages:

1. Plan
2. Execute
3. Merge
4. Learn

```text
Plan -> Execute -> Merge -> Learn -> Plan
```

### Plan

- classify task complexity
- split larger requests into dependency-aware subtasks
- choose model/agent profile from task type and budget state

### Execute

- dispatch work in isolated git worktrees
- stream progress and collect structured outcomes
- enforce timeout and budget limits at runtime

### Merge

- apply quality gates before integration
- attach diff evidence and task metadata
- merge successful branches, retain failed state for retry or analysis

### Learn

- extract patterns from failures and retries
- append repeatable lessons to project guidance
- improve prompts, guardrails, and routing rules over time

## 3. Task Tiers

CC-Manager should route tasks by complexity instead of using one fixed execution path.

| Tier | Typical Scope | Routing Strategy |
|---|---|---|
| Atomic | single-file or low-risk edits | one worker, fast model |
| Standard | multi-file feature work | one strong lead worker |
| Complex | cross-module changes | lead + delegated subtasks |
| Epic | architecture or migration work | plan engine + phased execution |

## 4. Quality and Verification

Throughput without trust is noise. The flywheel must enforce proof-first verification.

Recommended gates before merge:

- static checks and type checks
- targeted tests for changed behavior
- explicit acceptance criteria from the task prompt
- metadata artifact: duration, tokens, cost, changed files

## 5. Budget Intelligence

Budget policy should operate at multiple levels:

- per task
- per hour/day
- per run or release window

Dynamic model routing can reduce spend:

- use lightweight models for atomic tasks
- reserve higher-cost models for complex work
- degrade gracefully when budget thresholds are reached

## 6. V1 to V2 Path

### V1 (current focus)

- stable parallel execution
- reliable task API and event stream
- deterministic merge behavior with retries

### V1.5

- task decomposition engine
- conflict prediction and early warning
- richer historical analytics

### V2

- adaptive agent trees with delegated subtasks
- policy-driven auto-scaling based on queue pressure
- continuously improved orchestration rules from observed outcomes

## 7. Success Metrics

To prove the flywheel works, track these metrics over time:

- task success rate
- mean time to completion
- merge failure rate
- cost per successful task
- retry rate by task tier

A healthy flywheel shows increasing success and decreasing manual intervention at a stable cost envelope.
