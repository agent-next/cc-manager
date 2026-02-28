# Getting Started

This guide gets `cc-manager` running locally in minutes.

## 1. Prerequisites

- Node.js 20+
- `git`
- One supported agent CLI:
  - `claude` (Anthropic CLI)
  - `codex` (OpenAI Codex CLI)
  - any custom command that accepts a prompt
- Anthropic API key for Claude-based runs:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## 2. Install

Choose one package manager:

```bash
# npm
npm install -g cc-manager

# pnpm
pnpm add -g cc-manager

# yarn
yarn global add cc-manager
```

If `npm` is unavailable in your environment, use `pnpm` or `yarn`.

## 3. Run the Server

```bash
cc-manager --repo /path/to/your/repo
```

Important flags:

- `--workers <n>`: parallel worker count (1-20)
- `--port <n>`: server port (default `8080`)
- `--agent <cmd>`: default agent (`claude`, `codex`, or custom command)
- `--budget <usd>`: per-task spending guardrail
- `--total-budget <usd>`: total spending guardrail across all tasks

Example:

```bash
cc-manager \
  --repo /path/to/your/repo \
  --workers 6 \
  --agent codex \
  --budget 3 \
  --total-budget 50
```

## 4. Submit Your First Task

```bash
curl -X POST http://localhost:8080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Add input validation to the login form"}'
```

## 5. Watch Real-Time Events

```bash
curl -N http://localhost:8080/api/events
```

Common event types:

- `task_queued`
- `task_started`
- `task_progress`
- `task_final`

## 6. Verify Results

```bash
# List recent tasks
curl http://localhost:8080/api/tasks

# Task details
curl http://localhost:8080/api/tasks/<task-id>

# Patch for completed task
curl http://localhost:8080/api/tasks/<task-id>/diff
```

## 7. Run from Source (Optional)

```bash
git clone https://github.com/agent-next/cc-manager.git
cd cc-manager
npm install
npm run build
node dist/index.js --repo /path/to/your/repo
```

## Next Documents

- [Configuration Reference](./CONFIGURATION.md)
- [API Reference](./API.md)
- [Operations Guide](./OPERATIONS.md)
- [Agent Flywheel Design](./AGENT-FLYWHEEL-DESIGN.md)
