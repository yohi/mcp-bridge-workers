# Security scope and open gates

## Existing transport PoC (mock-tested only)

- Portal bearer value >=32 characters is required before contacting upstream.
- Upstream URL is fixed, HTTPS, and caller query strings are not forwarded.
- Caller Authorization/cookies and non-allowlisted headers are not forwarded.
- Upstream 401/403 and redirects are not forwarded as OAuth challenges.
- `tools/call` is gated by an explicit **top-level tool-name** allowlist.
- No real credentials are included in source code, test fixtures, or logs.

## Current staged OAuth route — mcp-remote@0.14.3 (PR #2)

- Authentication is delegated to the same pinned mcp-remote version as the operator's separately successful chatgpt-mcp-tunnel.
- A dedicated auth-only Docker Compose service (Linux host networking, explicit human invocation) uses port 38678, a separate named credential volume, and a JSON metadata file pinning only `read:bitbucket:agent-interface`.
- It may perform DCR, consent, exchange and refresh **only when the human explicitly runs** `npm run auth:atlassian-local`; never from CI or Worker code.
- No credentials are mounted from chatgpt-mcp-tunnel or made available to the Worker. No local-to-cloud handoff exists.
- This specific restricted-scope deployment is **NOT RUNTIME PROVEN**. The broader-scope successful tunnel does not establish that the new scope succeeds.
- `npm run probe:atlassian-localhost` has been removed. The old source file exists solely as a historical, explicit-opt-in experiment and should not be repeated without a separate review.
- Detailed [adoption plan and gates](mcp-remote-auth-adoption.md).

## Historical OAuth v2 feasibility (bespoke DCR; retired)

- **Fail closed on v2 OAuth discovery:** require the exact `/v2/mcp` protected-resource metadata URL and its tenant-scoped Atlassian Identity issuer.
- Never use `mcp.atlassian.com/v1/authorize`, `/v1/token`, `/v1/register` for new v2 feasibility tests.
- Require advertised PKCE S256, Authorization Code, DCR and `read:bitbucket:agent-interface` before explicit DCR / browser callback test.
- `npm run check:atlassian-oauth`: read-only metadata GET; no login, registration or token.
- Former `npm run probe:atlassian-localhost`: retired from package scripts after repeated post-Accept `invalid_request`; the historical test tool is not the supported authentication route.
- Any prior success output using the root v1 metadata is **not v2 evidence**. See [OAuth runbook](oauth-feasibility.md).

## NOT PROVEN / NOT IMPLEMENTED

- Historical Bridge DCR registration was observed successful; its custom Bitbucket-only consent failed twice after Accept. Scoped mcp-remote replacement not yet executed.
- Token exchange, refresh, local-to-Worker handoff, rotation and encrypted D1 store.
- Read-only enforcement of deferred nested `executeRead` operations; naming is not authorization.
- `tools/list` filtering; a caller may see blocked tools.
- Per-user identity mapping: shared upstream credential would give every Portal caller one Atlassian identity. **Single-user prototype only**.
- Real MCP Portal / Worker / Rovo MCP interoperability, Workers Free CPU usage.

The `/health` endpoint reports static status only; `/mcp` requires authorization. **No permission is granted by this PoC to connect company data or deploy.**

## Atlassian DCR compatibility note

Atlassian may issue an unexpected `client_secret` for a public client with `token_endpoint_auth_method=none`. The localhost callback-only probe ignores that field, never logs, stores or uses it, and requires a literal returned `none` authentication method and exact callback URI. Registration HTTP success can create a client even if validation stops later. See [OAuth runbook](oauth-feasibility.md). No tokens are exchanged.


## Scope differential diagnosis (2026-10-20)

User reported invalid_request after Accept in the new scoped mcp-remote integration. No success claim may be made based on CI. The dedicated scope metadata inspector only locally reads saved token fields in the already-working tunnel and prints allowlisted booleans/counts. It does not migrate, log or expose the tokens. Do not re-run OAuth registration or introduce extra permissions without new evidence and approval. See [offline scope check](mcp-remote-success-scope-check.md).


## Successful-client requested vs granted scopes: operator evidence (2026-10-20)

The read-only inspector on the now-logged-in existing tunnel returned 40 requested vs 21 granted scopes; the classification found no write/delete/manage prefixes in the **granted_scope field**. This is not a security proof that all mutation pathways are unavailable. The working client's observed granted scopes also include Jira/Confluence Read, identity scopes and offline_access, so copying the successful client's credentials or default scopes to Bridge would exceed its Bitbucket-only target. New live login experiments must require explicit authorization and an independently reviewed narrow scope set. Source [sanitized evidence](mcp-remote-success-scope-check.md#operator-verified-successful-scope-classification-2026-10-20-jst).
