# MCP Bridge Workers

Reusable, **experimental** Streamable HTTP bridges from Cloudflare MCP Portal to remote MCP providers, deployed as separate Cloudflare Workers sharing a small core library. **Not production-ready.**

```text
ChatGPT / OpenCode --> Cloudflare MCP Portal --> Worker (per provider)
                                              --> Remote MCP server
```

## Structure

- `packages/core` — shared MCP relay transport and request checks
- `workers/atlassian` — Atlassian Rovo MCP v2 adapter
- `tools/local-oauth` — v2-only metadata inspection, historical DCR failure evidence, and a staged local `mcp-remote@0.14.3` auth client
- `docs` — architecture, security and OAuth feasibility protocol

## Validate locally (Node.js >=20)

```sh
npm install
npm test
npm run check:atlassian-oauth
```

This metadata check performs unauthenticated GETs against the **v2 protected-resource metadata**, then its advertised tenant-scoped Atlassian Identity authorization server. It will not fall back to `mcp.atlassian.com/v1/authorize`.

**OAuth feasibility:** the custom DCR probe repeatedly failed after Atlassian consent. It has been retired from normal npm scripts. The **connection-first local OAuth implementation** now uses the known-working `mcp-remote@0.14.3` with default metadata-based scope negotiation (the prior Bitbucket-only override is disabled) and a fresh dedicated Docker credential volume. The previously successful tunnel's credentials are not reused. See [local OAuth adoption](docs/mcp-remote-auth-adoption.md) for operator-controlled build/login instructions and outstanding gates. To start the local client explicitly, run `npm run auth:atlassian-local:build` followed by `npm run auth:atlassian-local` on an authorized Linux host. Login may request scopes broader than Bitbucket Read; review consent before approval. Do not run login from CI. Source-level v2 evidence remains in [the historical protocol](docs/oauth-feasibility.md).

Never commit credentials or secrets. The Worker requires two independent secrets: `PORTAL_BEARER_TOKEN` for Portal-to-Worker traffic, and `UPSTREAM_AUTHORIZATION` for the upstream Rovo MCP endpoint. Neither is configured by this repository or CI.

## Deployment (NOT performed)

The Worker may be deployed with `npm run deploy:atlassian` only after review. Restrict the MCP Portal mapping to **one user**. This PoC does not refresh Worker-side credentials or implement a safe localhost-to-Worker handoff. Local mcp-remote is capable of refreshing its own isolated cached credentials, but it does not make the Cloudflare Worker authenticated. Read [security](docs/security.md) and [v2 compatibility](docs/atlassian-v2-compatibility.md) before any deployment.

## Cloudflare Tunnel backed by local OAuth (staged)

The previously successful Bridge OAuth cache can now be used through a local HTTP→stdio adapter, with Cloudflare Access and a named Tunnel protecting the Worker→local hop. The Worker config selects `local_relay` and fails closed when its credentials are missing. No Atlassian OAuth token is copied into Workers. **Cloudflare deployment and actual Portal connection have not been executed.** See [operator runbook](docs/tunnel-local-relay.md).
