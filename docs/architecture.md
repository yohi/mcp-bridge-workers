# Architecture — Cloudflare MCP Portal to Atlassian Rovo (2026-10-21)

## Runtime path (connected and verified for one tool)

```text
ChatGPT / Cloudflare Portal (one authorized user; CodeMode)
  -> HTTPS Workers /mcp (Portal Bearer required)
  -> env.ATLASSIAN_RELAY_VPC.fetch('http://127.0.0.1/mcp')
  -> VPC Service (ID 01a15cd4-afbd-7e03-912e-22db7b459014)
  -> Tunnel CoreUltra7-270K (QUIC; Docker host networking)
  -> 127.0.0.1:18787 (local HTTP relay, independent Bearer)
  -> mcp-remote@0.14.3 in Docker (isolated local OAuth volume)
  -> Atlassian Rovo MCP v2
```

Cloudflare Free tier and the zone Bot Fight Mode remain enabled. The public hostname protected by Cloudflare Access still exists independently; it is no longer used by the active `local_relay_vpc` route. A return to public `local_relay` does not guarantee availability because Bot Fight Mode previously challenged the Worker→public-hostname request with 403.

## Boundaries

- The Portal Bearer and Relay Bearer are independent. No Atlassian OAuth access/refresh token is copied to the Worker or written to Git.
- VPC Service is restricted to one existing Tunnel and one loopback host/port. Public hostname and query parameters from MCP callers cannot select VPC destination.
- No automatic fallback from the VPC transport to the public hostname.
- `/health` is a static unauthenticated **Worker-only** liveness endpoint; it does not prove Atlassian reachability.
- `/health/vpc` is authenticated with Portal Bearer and tests VPC→Relay `GET /health`; it does not prove upstream OAuth.
- Normal `/mcp` follows fixed MCP method filtering and a per-Worker top-level tool allowlist.
- **Nested operation authorization remains unresolved.** A top-level `executeRead` tool name is not, by itself, proof that all possible operations and OAuth scopes are read-only. The PR #2 cleanup defaults both `discover` and `executeRead` to denied; an explicit (discouraged) opt-in remains until a concrete scoped design is approved.
- Per-user credential partitioning, session multiplexing, stream resumption, and production threat-model signoff are not implemented.

## Evidence and deployment stages

1. **Observed in actual service**: Operator QUIC logs, VPC /health 200, VPC JSON-RPC `ping` 200, `getAccessibleAtlassianResources` 200, and ChatGPT Portal CodeMode successful read-only tool invocation.
2. **Validated in CI (static/synthetic)**: fail-closed routing and allowed tool filtering, constrained Docker runtime, secret staging, and current code checks.
3. **Not yet runtime validated after the PR cleanup**: removal of debug endpoints and default-off discovery/executeRead gate; these changes require a separate operator deployment and post-deploy tool-list check.

Full operating procedure: [VPC MCP runbook](vpc-mcp-cutover-2026-10-21.md). Historical OAuth feasibility and retired approaches: [OAuth feasibility](oauth-feasibility.md).
