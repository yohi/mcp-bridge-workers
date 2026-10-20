# Security scope and open gates

## Existing transport PoC (mock-tested only)

- Portal bearer value >=32 characters is required before contacting upstream.
- Upstream URL is fixed, HTTPS, and caller query strings are not forwarded.
- Caller Authorization/cookies and non-allowlisted headers are not forwarded.
- Upstream 401/403 and redirects are not forwarded as OAuth challenges.
- `tools/call` is gated by an explicit **top-level tool-name** allowlist.
- No real credentials are included in source code, test fixtures, or logs.

## OAuth v2 feasibility (PR #2)

- **Fail closed on v2 OAuth discovery:** require the exact `/v2/mcp` protected-resource metadata URL and its tenant-scoped Atlassian Identity issuer.
- Never use `mcp.atlassian.com/v1/authorize`, `/v1/token`, `/v1/register` for new v2 feasibility tests.
- Require advertised PKCE S256, Authorization Code, DCR and `read:bitbucket:agent-interface` before explicit DCR / browser callback test.
- `npm run check:atlassian-oauth`: read-only metadata GET; no login, registration or token.
- `npm run probe:atlassian-localhost`: explicitly opted-in POST creating one DCR client, followed by local interactive consent; discard callback codes; no token exchange or handoff.
- Any prior success output using the root v1 metadata is **not v2 evidence**. See [OAuth runbook](oauth-feasibility.md).

## NOT PROVEN / NOT IMPLEMENTED

- Atlassian Identity DCR registration and Bitbucket localhost OAuth consent for the user's organization.
- Token exchange, refresh, local-to-Worker handoff, rotation and encrypted D1 store.
- Read-only enforcement of deferred nested `executeRead` operations; naming is not authorization.
- `tools/list` filtering; a caller may see blocked tools.
- Per-user identity mapping: shared upstream credential would give every Portal caller one Atlassian identity. **Single-user prototype only**.
- Real MCP Portal / Worker / Rovo MCP interoperability, Workers Free CPU usage.

The `/health` endpoint reports static status only; `/mcp` requires authorization. **No permission is granted by this PoC to connect company data or deploy.**

## Atlassian DCR compatibility note

Atlassian may issue an unexpected `client_secret` for a public client with `token_endpoint_auth_method=none`. The localhost callback-only probe ignores that field, never logs, stores or uses it, and requires a literal returned `none` authentication method and exact callback URI. Registration HTTP success can create a client even if validation stops later. See [OAuth runbook](oauth-feasibility.md). No tokens are exchanged.
