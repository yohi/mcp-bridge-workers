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

The Bitbucket virtual tool is **fixed to `diamondhead`** in Worker source and in the
nonsecret `BITBUCKET_WORKSPACE_SLUG` Wrangler variable. No approval artifact,
decision reference or digest is required. A mismatch disables the virtual tool.
It lists the first page (up to 25 repos), with no caller-selected workspace.

The deployment workflow is `Deploy Atlassian Worker`
(`.github/workflows/deploy-atlassian.yml`), and is **manual-only on `master`**.
Merging/pushing to `master` does **not** automatically deploy.

One-time setup:

1. In Cloudflare, create an account-scoped API token with the minimum
   **Edit Cloudflare Workers** permission for the specific deployment account.
   No tunnel token, OAuth cache or Relay/Portal Bearer should be moved to GitHub.
2. In GitHub repository **Settings → Secrets and variables → Actions**, set
   the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. In Cloudflare, ensure the *existing* Worker `atlassian-rovo-mcp-bridge`
   still has `PORTAL_BEARER_TOKEN` and `LOCAL_RELAY_BEARER_TOKEN` as Worker
   **secrets**, and that `ATLASSIAN_RELAY_VPC` points at the intended private
   VPC service (service ID in `workers/atlassian/wrangler.jsonc`).
   Wrangler's required-secrets declaration checks both on deployment.
4. Merge the PR, then open GitHub **Actions → Deploy Atlassian Worker →
   Run workflow → master → Run workflow**.

The workflow installs dependencies, runs the Node tests, and then invokes
the official `cloudflare/wrangler-action@v4` with
`workers/atlassian/wrangler.jsonc`. It does **not** change OAuth scopes,
register Atlassian clients, start Docker, or alter Cloudflare Tunnel settings.
Existing Worker secrets are preserved by Wrangler deployments; Wrangler
configuration remains the source of truth for plain-text variables.

After a successful deployment, verify through the connected ChatGPT Portal:

- `tools/list` exposes only `atlassianUserInfo`,
  `getAccessibleAtlassianResources`, and `listBitbucketRepositories`.
- `listBitbucketRepositories({})` returns a maximum of 25 `diamondhead`
  repositories with `name`, `slug`, and `truncated`.
- `discover`, direct generic `executeRead`, and write operations are not
  exposed or callable.

A green Actions deploy is **not** a substitute for that last runtime check.
If deployment or the Portal check fails, inspect the Actions logs and Worker
configuration without exposing Bearer tokens or OAuth cache contents.

## Local validation and optional manual deploy

```sh
git status --short
npm install --ignore-scripts --no-audit --no-fund
npm test
# Alternative to GitHub Actions, only after confirming the correct Cloudflare account:
npm run deploy:atlassian
```

Do **not** overwrite local uncommitted changes just to deploy. Docker profiles
for Relay and Tunnel are independently opt-in; do not run `docker compose down -v`,
regenerate saved secrets, or run new DCR/OAuth consent for Worker maintenance.
The merged source and the currently deployed Worker can differ until a
separate deploy occurs.
