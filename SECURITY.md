# Security Policy

## Scope

cc-manager is a **local development tool**. It is designed to run on a developer's machine or within a trusted internal network. It has no authentication and should **never** be exposed to the public internet.

## Known Limitations

| Area | Status | Mitigation |
|------|--------|------------|
| Authentication | None | Local use only; restrict via firewall or reverse proxy |
| CORS | Open (all origins) | Restrict at reverse proxy level if needed |
| Webhook SSRF | Partial — blocks private/loopback IPs | DNS rebinding not prevented; use trusted endpoints only |
| Rate limiting | Static key (`"direct"`) | Does not trust `x-forwarded-for`; add `--trust-proxy` if behind proxy |

## Reporting a Vulnerability

If you discover a security issue, please report it privately:

1. **Do NOT open a public issue.**
2. Email the maintainers or use [GitHub Security Advisories](https://github.com/agent-next/cc-manager/security/advisories).
3. Include steps to reproduce and potential impact.
4. We will respond within 7 days.

## Security Controls

- **Webhook URL validation**: Blocks loopback, RFC 1918 private ranges, and link-local addresses.
- **Rate limiting**: 30 requests/minute per client on task submission endpoints.
- **Input validation**: Prompt length limits, timeout bounds, priority enum enforcement.
- **Agent isolation**: Each agent runs in an isolated git worktree. `CLAUDECODE` and `CLAUDE_CODE_*` env vars are cleared to prevent Claude nesting.
- **SQLite WAL mode**: Prevents database corruption under concurrent access.
