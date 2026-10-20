# Security scope and open gates

## Prototype behaviors (mock-tested only)

- Portal bearer value >=32 characters is required before contacting upstream.
- Upstream URL is fixed, HTTPS, and caller query strings are not forwarded.
- Caller Authorization/cookies and non-allowlisted headers are not forwarded.
- Upstream 401/403 and redirects are not forwarded as OAuth challenges.
- `tools/call` is gated by an explicit tool-name allowlist.
- No real credentials are included in source code, test fixtures, or logs.

## OAuth feasibility experiment (PR #2)

- Metadata check: unauthenticated GET only, pinned Atlassian host, no redirects, no token access.
- Optional localhost probe: requires explicit `--register`. It **creates a DCR client** at Atlassian, then optionally observes the browser redirect on loopback.
- The localhost callback probe does **not** exchange, save, or forward authorization codes or tokens. Its status does not authorize Workers deployment.
- See [OAuth feasibility protocol](oauth-feasibility.md) for state distinctions, safety requirements, and commands.

## NOT PROVEN / NOT IMPLEMENTED

- Atlassian OAuth 2.1 PKCE with localhost redirect for the organization's tenant.
- Local browser auth helper capable of token exchange, secure Worker handoff, rotation, encrypted D1 store.
- Read-only safety of `executeRead` or any nested operation; name filtering is not an authorization proof.
- `tools/list` is passed through and may advertise blocked tools.
- Single upstream identity is reused for all Portal callers. **Restrict to one operator**. Multi-user support requires per-user isolation.
- Real Portal / Workers / Rovo MCP session continuity and Cloudflare Free CPU budget.

The `/health` endpoint reports static status only; `/mcp` requires authorization.
**Do not treat this PoC as approval to connect production Atlassian data.**
