# Atlassian MCP Bridge — security status and merge gates (2026-10-21)

## Proven within limited scope

- Existing ChatGPT Portal CodeMode → Worker → VPC Service → Tunnel → Docker relay → Atlassian Rovo route successfully executes argument-free `getAccessibleAtlassianResources` without HTTP 502.
- Workers VPC Service fixes `127.0.0.1:18787` behind a named QUIC Tunnel. Cloudflare Free and Bot Fight Mode remain enabled; no broad zone-level security bypass.
- The Worker validates the Portal Bearer before forwarding `/mcp`. The Relay independently checks its own Bearer.
- Only allowlisted MCP method names are forwarded. The same top-level tool authorization applies to `tools/list` and `tools/call`; top-level `executeWrite` / `executeDestructive` are rejected.
- Responses from upstream 401/403/redirects fail closed and do not expose upstream authentication headers or error body; oversized or malformed tool lists cannot bypass filtering.
- Local OAuth tokens stay in a Docker volume, not in the Worker or repository.

These facts **do not** prove the bridge is generally read-only. Do not present it as a production-grade universal security enforcement service.

## PR #2 finalization change — not deployed yet

- `ATLASSIAN_UNVERIFIED_READ_TOOLS=off` (checked-in default) denies `discover` and `executeRead` at both discovery and invocation. Only `atlassianUserInfo` and `getAccessibleAtlassianResources` remain visible at the Worker top level by default.
- Setting `ATLASSIAN_UNVERIFIED_READ_TOOLS=on` explicitly restores both tools but **must not be used to claim read-only safety**. Before enabling it, establish the actual nested operation-level allowlist (method and resource scope), upstream enforcement, OAuth permissions, and regression tests.
- Removed the dedicated `/mcp/vpc` test route and temporary HTTP 403 body-classification logger. Retained Portal-Bearer-protected `/health/vpc` to test transport liveness without forwarding any response body.
- VPC errors do not fall back automatically to the public hostname; legacy public relay remains a separate explicit route mode, not a healthy rollback guarantee.

## Open security / operational limitations

1. **Nested operations — gate CLOSED:** `discover` can reveal operation contracts and `executeRead` accepts caller-supplied operation names and inputs. Their read-only semantics are not independently verified in the full delegated execution chain. The default-off gate is compensating risk reduction, not proof of universal safety.
2. **Effective OAuth scopes — broader than Bitbucket Read possible:** Owner previously observed 40 requested / 21 granted scopes in a different existing tunnel and a fresh local negotiated login path. The current bridge may have cross-product access. Do not infer all mutations are technically impossible from scope names or a top-level read label.
3. **Single-user identity:** one Portal caller and one cached OAuth principal; no per-user delegated identity authorization.
4. **Local host trust:** Docker uses host network for relay/cloudflared, loopback listener and protected local secret files and volumes. Compromise of host/Docker administrator can compromise credentials.
5. **Protocol / operational limits:** single-user experimental JSON-RPC relay, not general MCP session/multiplexing coverage. Availability depends on Linux host, Tunnel, OAuth session and Cloudflare VPC beta.
6. **Historical custom OAuth DCR experiment failed after consent:** intentionally retired, not a production dependency. See [OAuth feasibility](oauth-feasibility.md). Do not retry DCR or re-consent merely for maintenance.

## Gate to mark PR Ready and merge

- [x] Architecture and runtime evidence recorded (limited operation, actual Portal path).
- [x] Cleanup committed with default-deny nested tool gate and restricted health endpoint.
- [ ] Latest cleanup commit passes Node 20, Node 22 and Docker CI.
- [ ] Operator deploys latest cleanup commit (the proven runtime predates this cleanup).
- [ ] Operator verifies actual Portal `getAccessibleAtlassianResources` succeeds and `tools/list` exposes exactly two default-allowed tools. No raw Atlassian payload or tokens shared.
- [ ] Owner reviews policy trade-off: intentional disabling of `discover` / `executeRead` means detailed Jira, Confluence and Bitbucket reads are unavailable until a separately reviewed opt-in.
- [ ] Human Owner authorizes marking the PR Ready and merging. PR must not be merged merely because CI is green.

Security incidents or endpoint failures require investigation and an explicit rollback. The former public Tunnel path is known to be blocked by zone Bot Fight Mode; rollback to it is not restoration of service. Preserve the working VPC version history for recovery.

## Archived evidence

- [OAuth feasibility and DCR](oauth-feasibility.md)
- [Local OAuth identity, constraints and historical scope analysis](mcp-remote-auth-adoption.md)
- [Legacy public-route deployment and Docker controls](tunnel-local-relay.md)
- [VPC verification, cutover, cleanup and rollback](vpc-mcp-cutover-2026-10-21.md)
