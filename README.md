# MCP Bridge Workers

Reusable, **experimental** Streamable HTTP bridges from Cloudflare MCP Portal to remote MCP providers, deployed as separate Cloudflare Workers sharing a small core library. **Not production-ready.**

```text
ChatGPT / OpenCode --> Cloudflare MCP Portal --> Worker (per provider)
                                              --> Remote MCP server
```

## Structure

- `packages/core` — shared MCP relay transport and request checks
- `workers/atlassian` — first provider adapter: Atlassian Rovo MCP
- `tools/local-oauth` — metadata-only discovery; local login not implemented
- `docs` — architecture and security limitations

## Validate locally (Node.js >=20)

```bash
npm install
npm test
npm run check:atlassian-oauth  # optional network read; no authentication
```

Never commit credentials or secrets. The Worker requires two independent secrets: `PORTAL_BEARER_TOKEN` for Portal-to-Worker traffic, and `UPSTREAM_AUTHORIZATION` for the upstream Rovo MCP endpoint. Neither is configured by this repository or CI.

## Deployment (NOT performed; review first)

A dedicated Worker can be deployed via `npm run deploy:atlassian` after review. Restrict the MCP Portal mapping to **one user**. This version neither refreshes upstream credentials nor implements localhost OAuth or secure token handoff.

Read [architecture](docs/architecture.md) and [security gates](docs/security.md) before any deployment. Live Atlassian integration and production use are out of scope for this PoC.
