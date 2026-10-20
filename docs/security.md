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
- A dedicated auth-only Docker Compose service (Linux host networking, explicit human invocation) uses port 38678 and a **new** named credential volume. Owner has temporarily approved removing the Bitbucket-Read-only scope override; this profile uses mcp-remote's default negotiated scopes, potentially including permissions beyond Bitbucket Read. Review consent and organizational policy before login.
- It may perform DCR, consent, exchange and refresh **only when the human explicitly runs** `npm run auth:atlassian-local`; never from CI or Worker code.
- No credentials are mounted from chatgpt-mcp-tunnel or made available to the Worker. No local-to-cloud handoff exists.
- The **previous fixed Bitbucket-only profile failed** after consent; the new negotiated-scope profile is **NOT RUNTIME PROVEN**. The original tunnel's success does not imply this fresh DCR client will succeed.
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
- Per-user identity mapping: shared upstream credential would give every Portal caller one Atlassian identity. **Single-user prototype only**.
- Real MCP Portal / Worker / Rovo MCP interoperability, Workers Free CPU usage.

The `/health` endpoint reports static status only; `/mcp` requires authorization. **No permission is granted by this PoC to connect company data or deploy.**

## Atlassian DCR compatibility note

Atlassian may issue an unexpected `client_secret` for a public client with `token_endpoint_auth_method=none`. The localhost callback-only probe ignores that field, never logs, stores or uses it, and requires a literal returned `none` authentication method and exact callback URI. Registration HTTP success can create a client even if validation stops later. See [OAuth runbook](oauth-feasibility.md). No tokens are exchanged.


## Scope differential diagnosis (2026-10-20)

User reported invalid_request after Accept in the new scoped mcp-remote integration. No success claim may be made based on CI. The dedicated scope metadata inspector only locally reads saved token fields in the already-working tunnel and prints allowlisted booleans/counts. It does not migrate, log or expose the tokens. Do not re-run OAuth registration or introduce extra permissions without new evidence and approval. See [offline scope check](mcp-remote-success-scope-check.md).


## Successful-client requested vs granted scopes: operator evidence (2026-10-20)

The read-only inspector on the now-logged-in existing tunnel returned 40 requested vs 21 granted scopes; the classification found no write/delete/manage prefixes in the **granted_scope field**. This is not a security proof that all mutation pathways are unavailable. The working client's observed granted scopes also include Jira/Confluence Read, identity scopes and offline_access, so copying the successful client's credentials or default scopes to Bridge would exceed its Bitbucket-only target. New live login experiments must require explicit authorization and an independently reviewed narrow scope set. Source [sanitized evidence](mcp-remote-success-scope-check.md#operator-verified-successful-scope-classification-2026-10-20-jst).

## Connection-first scope choice (2026-10-20)

Owner approved temporarily lifting the strict Bitbucket-only OAuth scope restriction to prioritize operational connection. The current Compose file omits `--static-oauth-client-metadata` and isolates the new negotiation in a fresh OAuth volume, without copying any tokens. Historical scoped registration and stored tokens are left intact. Existing Cloudflare Worker does not gain new privileges or receive a credential. Since OAuth may request mutating scopes, local permission safety must **not** be asserted. See [current local connection instructions](mcp-remote-auth-adoption.md).


## Staged Worker-to-local relay security boundary

The Worker now supports `local_relay` mode, explicitly selected in the deployable Wrangler config. Required HTTPS route and Access Service Auth credentials are Worker secrets; no local OAuth token is exported. Cloudflare Access is expected to enforce a Service Auth policy at the Tunnel hostname. The local listener binds to 127.0.0.1 and checks an unrelated bearer before reading MCP messages; its Docker Compose secret comes from a Git-ignored local file. This is a single-user PoC. GET SSE, per-session routing, full RPC capability negotiation, stream cancellation, deferred tool authorization and Cloudflare Portal connectivity remain **unverified**. [Runbook](tunnel-local-relay.md).


## Docker-only cloudflared connector (optional, staged)

The `tunnel` Compose profile uses the official, version-pinned `cloudflare/cloudflared:2026.10.1` image with `--token-file` (Cloudflare supports this flag since 2025.4.0), never a token in process arguments or environment variables. The token is stored in a Git-ignored 0600 host file then staged by an **offline one-shot helper** into a separate 0400, UID-1000 private volume. The connector reads that volume read-only and runs as nonroot, read-only root filesystem, with dropped caps and no Docker socket. Host networking is needed for the loopback-only relay but **reduces container network isolation**. Secure the hostname with Cloudflare Access Service Auth **before** adding a public route. Do not mistake the Tunnel connector token for the Access Service Token or Portal bearer. The Linux host retains local copies of the connector token; Docker admins/backups may access them. Neither the Tunnel nor Cloudflare Access or Worker have been configured by this commit. [Runbook](tunnel-local-relay.md#docker-only-cloudflare-tunnel-connector-opt-in-2026-10-20).

## Worker tools/list filter — proposal implemented on PR #2 (not deployed at this commit)

- The upstream Atlassian MCP endpoint returned 14 tool definitions in the operator's successful live `tools/list` test, including `executeWrite` and `executeDestructive`. The existing Worker only authorizes top-level `tools/call` names `atlassianUserInfo`, `getAccessibleAtlassianResources`, `discover` and `executeRead`. Earlier runtime displayed all 14 names.
- This correction applies the **same allowlist** to the returned `tools/list` JSON-RPC response, keeping allowed tool definitions and `nextCursor` intact for each page, and preserving existing `tools/call` rejection. A missing/unexpected/non-JSON/SSE/oversized tools-list body causes a **502 fail-closed** response, never an unfiltered passthrough. Ordinary `initialize` and notification responses remain unchanged.
- Tests use synthetic upstream lists to prove blocked tool names are absent and blocked `tools/call` methods never reach the upstream even in `local_relay` mode. The filter must still be **deployed and observed against the real Atlassian endpoint** before the Portal is registered.
- **Residual limitation — NOT PROVEN READ-ONLY:** `discover` can advertise operations of multiple risk tiers; `executeRead` forwards arbitrary discovered operation names and inputs without the Worker independently enforcing their resource-level semantics. The upstream's designation as `Read` and granted OAuth scopes cannot, on their own, establish every nested operation as side-effect free. This change blocks top-level write/destructive tools but does **not** impose a nested-operation allowlist, revoke write-capable OAuth scopes, or prove read-only operation. Defer any stronger safety claim until the actual `discover`/`executeRead` contract and scope constraints are independently verified.

## 2026 MCP era negotiation compatibility — limited correction (pending deployment)

- Cloudflare MCP Portal registration reached the Worker with valid Bearer authentication but failed during protocol-version negotiation with `id: server-discover-probe-1`, HTTP 403 and JSON-RPC `-32001`. The connected Cloudflare API reports `authentication_status=connected`, `status=error`, `error_details.cause=Version negotiation failed: the server denied access (HTTP 403)`.
- This ID is used by current MCP SDK clients when probing the modern 2026-07-28 era with method `server/discover`; the pinned Atlassian upstream successfully negotiated legacy `2025-03-26` via `initialize`. A 401/403 probe answer is interpreted as authorization denial, not a legacy server.
- The Worker now recognizes only an authenticated, well-formed JSON-RPC `server/discover` request with a concrete request ID and answers locally **HTTP 200 / JSON-RPC -32601 Method not found**. The bridge deliberately does not claim to implement 2026-07-28, nor forward this probe or expand its allowed method/tool list. Tests cover probe shape, 401 when unauthenticated, legacy fallback `initialize` and filtered `tools/list`, prohibited top-level writes, and continued refusal of all other unknown methods.
- This is a **proposal fix**, NOT a live compatibility proof. After operator-controlled Worker deployment, re-sync the Cloudflare MCP server and verify Ready + exactly four tools; if another method fails, diagnose it specifically rather than relaxing the entire MCP allowlist. Unproven nested `discover`/`executeRead` semantics remain open.
