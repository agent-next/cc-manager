# Configuration Reference

This document describes all configuration options for cc-manager.

---

## CLI Flags

### `--repo <path>` *(required)*

Path to the Git repository that workers will operate on.

| | |
|---|---|
| **Default** | *(none — required)* |
| **Type** | string (filesystem path) |
| **Validation** | Path must exist and contain a `.git` directory |

```bash
cc-manager --repo /path/to/my-project
```

---

### `--workers <n>`

Number of parallel Claude agent workers to run simultaneously.

| | |
|---|---|
| **Default** | `10` |
| **Type** | integer |
| **Valid range** | 1 – 20 (inclusive) |

```bash
cc-manager --repo . --workers 5
```

---

### `--port <n>`

TCP port the HTTP server listens on for the web UI and API.

| | |
|---|---|
| **Default** | `8080` |
| **Type** | integer |
| **Valid range** | 1024 – 65535 (inclusive) |

```bash
cc-manager --repo . --port 3000
```

---

### `--timeout <s>`

Maximum time in seconds that a single task is allowed to run before it is cancelled.

| | |
|---|---|
| **Default** | `300` (5 minutes) |
| **Type** | integer |
| **Valid range** | > 0 |

```bash
cc-manager --repo . --timeout 600
```

---

### `--budget <usd>`

Maximum spend in USD allowed for a single task. Set to `0` for unlimited.

| | |
|---|---|
| **Default** | `5` |
| **Type** | float |
| **Valid range** | ≥ 0 (`0` = unlimited) |

```bash
cc-manager --repo . --budget 2.50
```

---

### `--total-budget <usd>`

Global spend cap in USD across **all** tasks in the session. Once this limit is reached no new tasks are started. Set to `0` for unlimited.

| | |
|---|---|
| **Default** | `0` (unlimited) |
| **Type** | float |
| **Valid range** | ≥ 0 (`0` = unlimited) |

```bash
cc-manager --repo . --total-budget 50
```

---

### `--model <id>`

Claude model identifier passed to every agent session.

| | |
|---|---|
| **Default** | `claude-sonnet-4-6` |
| **Type** | string |
| **Valid values** | Any supported Claude model ID (e.g. `claude-opus-4-6`, `claude-sonnet-4-6`) |

```bash
cc-manager --repo . --model claude-opus-4-6
```

---

### `--system-prompt <text>`

System prompt text prepended to every agent session. Ignored if `--system-prompt-file` is also provided.

| | |
|---|---|
| **Default** | `""` (empty) |
| **Type** | string |
| **Precedence** | Overridden by `--system-prompt-file` |

```bash
cc-manager --repo . --system-prompt "Always write tests for new code."
```

---

### `--system-prompt-file <path>`

Path to a file whose contents are used as the system prompt for every agent session. Takes precedence over `--system-prompt`.

| | |
|---|---|
| **Default** | *(none)* |
| **Type** | string (filesystem path) |
| **Precedence** | Overrides `--system-prompt` |

```bash
cc-manager --repo . --system-prompt-file ./prompts/strict.txt
```

---

## Environment Variables

### `ANTHROPIC_API_KEY` *(required)*

Your Anthropic API key, used by the Claude agent SDK to authenticate all model requests. The application will fail to run agents without this variable set.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Obtain a key at <https://console.anthropic.com>.

---

## Example Configurations

### Development (3 workers, generous timeouts)

Suitable for a local dev machine where resource usage should stay low and you want extra time to observe long-running tasks.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

cc-manager \
  --repo . \
  --workers 3 \
  --port 8080 \
  --timeout 600 \
  --budget 10 \
  --model claude-sonnet-4-6
```

---

### Production (10 workers, tighter budgets)

Suitable for a dedicated server processing a high volume of tasks with controlled costs.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

cc-manager \
  --repo /srv/repo \
  --workers 10 \
  --port 8080 \
  --timeout 300 \
  --budget 3 \
  --total-budget 100 \
  --model claude-sonnet-4-6 \
  --system-prompt-file /etc/cc-manager/system-prompt.txt
```

---

### CI/CD Integration

Suitable for running inside a pipeline (e.g. GitHub Actions, GitLab CI). Use a low worker count to avoid overloading the runner, a short timeout to keep pipelines fast, and a strict total budget to prevent runaway spend.

```bash
# Set ANTHROPIC_API_KEY via your CI secret store, then:

cc-manager \
  --repo "$GITHUB_WORKSPACE" \
  --workers 2 \
  --port 8080 \
  --timeout 120 \
  --budget 2 \
  --total-budget 20 \
  --model claude-sonnet-4-6
```

Example GitHub Actions step:

```yaml
- name: Run cc-manager
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    cc-manager \
      --repo "$GITHUB_WORKSPACE" \
      --workers 2 \
      --timeout 120 \
      --budget 2 \
      --total-budget 20
```
