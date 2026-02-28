# Operations Guide

Operational runbook for `cc-manager` in shared or production environments.

## Runtime Baseline

Recommended baseline:

- Node.js 22 LTS
- 4-10 workers for general workloads
- dedicated repo clone per environment
- persistent storage for `.cc-manager.db`

Start command example:

```bash
cc-manager \
  --repo /srv/repos/target-repo \
  --workers 8 \
  --port 8080 \
  --budget 3 \
  --total-budget 150
```

## Service Management

Example `systemd` unit (`/etc/systemd/system/cc-manager.service`):

```ini
[Unit]
Description=CC-Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/cc-manager/v1
Environment=ANTHROPIC_API_KEY=sk-ant-...
ExecStart=/usr/local/bin/cc-manager --repo /srv/repos/target-repo --workers 8 --port 8080
Restart=always
RestartSec=3
User=ccmanager
Group=ccmanager

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cc-manager
sudo systemctl start cc-manager
sudo systemctl status cc-manager
```

## Upgrade Procedure

1. Pull latest code.
2. Install dependencies.
3. Build TypeScript output.
4. Restart service.
5. Run health and smoke checks.

```bash
git pull
npm ci
npm run build
sudo systemctl restart cc-manager
curl http://localhost:8080/api/health
```

## Backup and Recovery

`cc-manager` stores task state in SQLite files at repository root:

- `.cc-manager.db`
- `.cc-manager.db-shm`
- `.cc-manager.db-wal`

Daily backup recommendation:

```bash
tar -czf cc-manager-backup-$(date +%F).tgz \
  .cc-manager.db .cc-manager.db-shm .cc-manager.db-wal
```

Recovery:

1. Stop the service.
2. Restore database files.
3. Start the service.
4. Verify `/api/health` and `/api/stats`.

## Monitoring Checklist

- `GET /api/health`: liveness and worker summary
- `GET /api/stats`: queue depth, active workers, budget state
- `GET /api/tasks/errors`: recent failures
- `GET /api/workers`: worker saturation

Suggested alerts:

- queue depth above expected threshold for 10+ minutes
- repeated task failures above baseline
- total budget near hard cap
- no successful tasks in a rolling time window

## Troubleshooting

### Agent command not found

Symptom: tasks fail immediately with command execution errors.

Actions:

- confirm CLI is installed (`claude --version`, `codex --version`)
- confirm binary is in service `PATH`
- set explicit `--agent` command

### Tasks time out frequently

Actions:

- increase `--timeout`
- reduce `--workers` if host is saturated
- split large prompts into smaller tasks

### Merge conflicts increase with load

Actions:

- reduce parallelism for high-overlap code areas
- use tags to segment queue by subsystem
- retry failed tasks with narrower prompts

### Budget exhausted too quickly

Actions:

- lower per-task `--budget`
- set `--total-budget` to enforce global limits
- move lower-priority work to off-peak windows

## Security Notes

- keep API keys in environment variables or a secret manager
- avoid embedding secrets in task prompts
- restrict network exposure of the server port
- route through TLS and auth at an ingress or proxy layer

## Related Docs

- [Getting Started](./GETTING_STARTED.md)
- [Configuration Reference](./CONFIGURATION.md)
- [API Reference](./API.md)
