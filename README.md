# MCP Bridge Workers

Experimental, single-owner Atlassian Rovo MCP bridge using Cloudflare MCP Portal and Cloudflare Workers. This repository contains an **operator-deployed working VPC transport**, plus historical OAuth feasibility experiments. It is **not certified as a general-purpose read-only Atlassian proxy**.

## Current architecture (verified 2026-10-21 JST)

```text
ChatGPT (single authorized caller)
  -> Cloudflare MCP Portal (CodeMode)
  -> atlassian-rovo-mcp-bridge Worker (/mcp, Portal Bearer)
  -> Workers VPC Service Binding ATLASSIAN_RELAY_VPC
  -> Cloudflare Tunnel CoreUltra7-270K (QUIC)
  -> http://127.0.0.1:18787/mcp (independent Relay Bearer)
  -> local Docker relay -> mcp-remote@0.14.3
  -> Atlassian Rovo MCP v2 (OAuth cache kept in a local Docker volume)
```

The VPC Service `atlassian-relay-private` connects to the existing Tunnel and fixed local endpoint. Cloudflare Free and zone-level Bot Fight Mode remain in use. **No public-hostname bypass, WAF exception, Gateway routing change, or token migration** was necessary. The pre-existing public Access-protected hostname remains configured, but the current production `/mcp` Worker route uses the private VPC Binding.

Runtime evidence: the owner obtained HTTP 200 JSON-RPC results over VPC for both `ping` and `getAccessibleAtlassianResources`. Subsequently ChatGPT Portal CodeMode successfully called `getAccessibleAtlassianResources({})` without the earlier HTTP 502. This demonstrates connectivity for that read-only operation; it does **not** establish general write-prevention, full MCP sessions, or all Atlassian permissions.

## Safe operation and security gates

- Portal-to-Worker Bearer validation is mandatory for `/mcp`; relay has its own independent Bearer. Keep both secrets out of Git, logs, chat, and CLI arguments.
- `tools/list` is filtered and `tools/call` is authorized by the **same top-level allowlist**. `executeWrite` and `executeDestructive` are blocked before upstream.
- **PR #2 cleanup (not live until separately deployed):** unverified nested `discover` and `executeRead` are **default-denied**, including in tool discovery. `ATLASSIAN_UNVERIFIED_READ_TOOLS=off` is the supported safety baseline. Only set `on` after independent review of the exact nested operation contract and effective authorization. Enabling it is not proof of safe read-only behavior.
- The latest cleanup removes the temporary `/mcp/vpc` test endpoint and Cloudflare challenge-body diagnostic. `GET /health/vpc` remains as a Portal-Bearer-protected network liveness check.
- `ATLASSIAN_UPSTREAM_MODE=local_relay_vpc` is the supported active mode. VPC failures **fail closed** without automatic fallback to the public hostname.
- The local mcp-remote OAuth negotiation may grant scopes beyond Bitbucket Read. This is a **single-user experimental bridge**, not a per-user delegated authorization solution.

See [Security](docs/security.md), [Architecture](docs/architecture.md), and [Operator runbook](docs/vpc-mcp-cutover-2026-10-21.md). Historical OAuth/DCR investigations are preserved in [OAuth feasibility](docs/oauth-feasibility.md) and [local OAuth adoption](docs/mcp-remote-auth-adoption.md).

## Repository

- `packages/core`: stateless HTTP MCP gateway, request checks and filtering
- `workers/atlassian`: Atlassian Worker and Wrangler configuration
- `tools/local-relay`: loopback-only HTTP-to-stdio relay
- `tools/local-oauth`: Docker OAuth client, Tunnel connector, offline inspection utilities
- `docs`: architecture, security, incident evidence and operator runbooks

## Validate and deploy (operator only)

```sh
git status --short
npm install --ignore-scripts --no-audit --no-fund
npm test
# After reviewing the diff and confirming the destination account:
npm run deploy:atlassian
```

Do **not** run a deployment or overwrite local uncommitted changes solely to close a PR. Docker profiles for relay and Tunnel are independently opt-in; do not run `docker compose down -v`, regenerate saved secrets, or perform a new Atlassian DCR/OAuth consent flow for ordinary Worker maintenance.

PR #2 remains **Draft until the cleanup commit is deployed and its reduced tool visibility is confirmed**. Its earlier production-connectivity success applies to the VPC cutover baseline, not automatically to later cleanup changes.
