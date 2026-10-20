# MCP Bridge Workers

Reusable, **experimental** Streamable HTTP bridges from Cloudflare MCP Portal to remote MCP providers, deployed as separate Cloudflare Workers sharing a small core library. **Not production-ready.**

```text
ChatGPT / OpenCode --> Cloudflare MCP Portal --> Worker (per provider)
                                              --> Remote MCP server
```

## Structure

- `packages/core` — shared MCP relay transport and request checks
- `workers/atlassian` — Atlassian Rovo MCP v2 adapter
- `tools/local-oauth` — **v2-only** OAuth metadata discovery and opt-in loopback callback test
- `docs` — architecture, security and OAuth feasibility protocol

## Validate locally (Node.js >=20)

```sh
npm install
npm test
npm run check:atlassian-oauth
```

This metadata check performs unauthenticated GETs against the **v2 protected-resource metadata**, then its advertised tenant-scoped Atlassian Identity authorization server. It will not fall back to `mcp.atlassian.com/v1/authorize`.

**OAuth feasibility:** read [docs/oauth-feasibility.md](docs/oauth-feasibility.md). The optional `npm run probe:atlassian-localhost` sends a DCR registration POST only when explicitly run on an authorized local machine. It never exchanges, stores or forwards tokens.

Never commit credentials or secrets. The Worker requires two independent secrets: `PORTAL_BEARER_TOKEN` for Portal-to-Worker traffic, and `UPSTREAM_AUTHORIZATION` for the upstream Rovo MCP endpoint. Neither is configured by this repository or CI.

## Deployment (NOT performed)

The Worker may be deployed with `npm run deploy:atlassian` only after review. Restrict the MCP Portal mapping to **one user**. This PoC neither refreshes upstream credentials nor implements localhost OAuth token handoff. Read [security](docs/security.md) and [v2 compatibility](docs/atlassian-v2-compatibility.md) before any deployment.
