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

## Deploy Atlassian Worker (manual GitHub Actions)

Workspace access is determined by the existing Atlassian Rovo OAuth session,
not by a value configured in GitHub or Cloudflare. Only two dedicated read
operations are exported:

- `listBitbucketWorkspaces({})`: return a bounded first page of workspaces
  visible to the authenticated Atlassian user.
- `listBitbucketRepositories({workspaceId: "workspace-slug"})`: read at most
  25 repositories from a selected workspace. Atlassian validates the effective
  OAuth scope and per-workspace permission for this operation. Workspace IDs
  are not selected or granted by this Worker.

These operations use the pre-existing private VPC relay and OAuth session.
The Worker does **not** expose raw `discover`, general-purpose `executeRead`
or any write/destructive tool. The current read-only workspace enumeration
and payload shape are based on the official Rovo catalog; confirm
`listBitbucketWorkspaces`'s exact descriptor and live response using the
local OAuth session before depending on it in production.

The deployment workflow is `Deploy Atlassian Worker`
(`.github/workflows/deploy-atlassian.yml`) and is **manual-only on `master`**.
Merging/pushing to `master` does **not** automatically deploy.

One-time setup:

1. Create an account-scoped Cloudflare API token with the minimum
   **Edit Cloudflare Workers** permission for the intended deployment account.
2. In GitHub repository **Settings → Secrets and variables → Actions**, set
   repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   **No Bitbucket Workspace variable is needed.**
3. Confirm that the existing Cloudflare Worker `atlassian-rovo-mcp-bridge`
   still has `PORTAL_BEARER_TOKEN` and `LOCAL_RELAY_BEARER_TOKEN` as
   Worker secrets, and that its `ATLASSIAN_RELAY_VPC` binding is correct.
4. After review and merge, open GitHub **Actions → Deploy Atlassian Worker →
   Run workflow → master → Run workflow**.

The workflow installs dependencies, runs Node tests, then runs the official
`cloudflare/wrangler-action@v4` with the existing Wrangler config. It does not
change OAuth grants, local Docker data, the Cloudflare Tunnel or Worker Bearer
secrets. After deployment, refresh the connected ChatGPT MCP tool list and
confirm that it contains only the two existing Atlassian metadata tools and
the two Bitbucket read tools above. Check that Workspace discovery, a selected
repository list and an unauthorized Workspace denial behave as expected.

A green deployment is not proof of the live Rovo operation shape or the
effective OAuth consent boundary.

## Local validation

```sh
git status --short
npm install --ignore-scripts --no-audit --no-fund
npm test
```

Do **not** overwrite local uncommitted changes just to deploy. Docker profiles
for Relay and Tunnel are independently opt-in; do not run `docker compose down -v`,
regenerate saved secrets, or run new DCR/OAuth consent for Worker maintenance.
The merged source and the currently deployed Worker can differ until a
separate deploy occurs.
