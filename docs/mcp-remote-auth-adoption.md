# Adopt known-working mcp-remote v0.14.3 for local Atlassian OAuth (PR #2)

**Status: implementation staged, never executed by CI or the assistant.**
The user's `chatgpt-mcp-tunnel` successfully authenticated against `https://mcp.atlassian.com/v2/mcp` via `mcp-remote@0.14.3`, including a Bitbucket workspace read. The Bridge's bespoke DCR/PKCE probe, in contrast, twice reached Atlassian consent but received `invalid_request` after Accept. Do not repeat that experiment as a default path.

## What is implemented

- Local **Linux Docker Compose** auth-only service using **mcp-remote-client@0.14.3**, Node.js 22, `http-only`, and `http://localhost:38678/oauth/callback`. Separate port from the working tunnel's default `38677` avoids collision.
- Dedicated named Docker volume under a different Compose project, not shared with `chatgpt-mcp-tunnel`.
- `--static-oauth-client-metadata @/etc/mcp-bridge/bitbucket-readonly-client.json` pins `scope: read:bitbucket:agent-interface` and **does not copy broad Jira/Confluence/write scopes**.
- Upstream mcp-remote retains responsibility for v2 discovery, DCR, OAuth authorization, PKCE, code exchange and local token refresh. **Not independently proven in this newly isolated read-only configuration.**
- The repository retains the earlier bespoke DCR probe **only as archived investigation code**; it is removed from normal npm scripts. Running `check-localhost-redirect.mjs --register` manually would still register a new client: do not do so.
- No Worker token handoff, token injection or credential access implemented.

## Explicit manual operations (NOT done by assistant / CI)

First review company approval for the OAuth client, including the particular scope. On the Linux host, from the mcp-bridge-workers repository root:

```bash
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run auth:atlassian-local:build

# ONLY after explicitly consenting to one new DCR registration and OAuth login:
npm run auth:atlassian-local
```

The build step downloads packages and Docker image layers but performs no Atlassian login. The **auth** step can create an Atlassian OAuth client, trigger browser consent, exchange an authorization code, save access/refresh tokens and list tools. Unlike the old callback-discarding probe, it can maintain a local OAuth session. Opening the generated authorization URL must happen in the browser on that same Linux host.

The auth command is **not a guaranteed solution to the earlier `invalid_request`**: the pinned Bitbucket-only scope differs from the previously working `mcp-remote` default. The actual remote result remains **NOT TESTED** until a human runs it. Do not share terminal output: it can include an authorization URL, tool metadata, organizational identifiers or error details. Share sanitized milestone statuses only, not tokens, IDs or raw OAuth URLs.

**No credential reuse:** This compose file deliberately does not mount `chatgpt-mcp-tunnel`'s OAuth volume or reference its control plane API key. Do not copy `client_info.json`, `tokens.json` or PKCE cache from the successful tunnel: that would silently reuse whatever broader scopes it was granted.

**Host-network limitation:** `network_mode: host` reduces container network isolation. Use only on a trusted Linux host; this mode is not a supported Cloudflare Workers runtime. Named Docker cache is not encrypted by this project; restrict host/Docker access, do not back it up casually, and never run commands such as `docker compose down -v` without separately approving deletion of the OAuth cache.

## Architecture and critical unresolved gates

```text
Linux host
  browser -> localhost:38678/oauth/callback
              ^  mcp-remote-client@0.14.3
              |  private OAuth volume (not exposed)
              v
         Atlassian Rovo MCP v2

Cloudflare MCP Portal -> Cloudflare Worker -> Rovo MCP v2
                                       ^
                                       |
                              NO credential bridge exists
```

The local Docker client **cannot make the Cloudflare Worker authenticated by itself**. Worker still expects `UPSTREAM_AUTHORIZATION` as a separately provisioned bearer value. Nothing here copies or transfers local tokens to Workers, logs them, writes a local token export or changes the Worker. Treat authentication-to-Worker handoff as a separate security design requiring explicit human approval, per-user binding, encrypted storage, token expiry/refresh and revocation semantics before any implementation.

Even successful local OAuth **does not prove** Bitbucket Read-only enforcement for nested `executeRead` operations, tools/list filtering, Portal caller identity binding, or the Cloudflare Workers Free resource model. Leave those gates blocked.

## Exit criteria

1. Local client using scoped mcp-remote succeeds without falling back to legacy OAuth or gaining write grants.
2. Token state stays only in this isolated local volume; no raw secrets or tenant information are uploaded.
3. Separately design and review the credentials handoff, identity mapping, and strict nested read-only authorization.
4. Only after those gates pass, begin end-to-end Portal -> Worker -> Atlassian tests.

**Do not claim OAuth or Worker end-to-end success based on unit tests, successful Docker build, or the other project's known-good session.**
