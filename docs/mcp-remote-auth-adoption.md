# Atlassian Rovo MCP v2 — connection-first local OAuth

**Current path (2026-10-20):** Start with the exact OAuth scope negotiation behavior that already worked in `chatgpt-mcp-tunnel`, rather than another Bitbucket-only DCR experiment.

## What changed

The local Bridge auth service uses pinned **`mcp-remote@0.14.3`** without any `--static-oauth-client-metadata` override. The package discovers the Rovo MCP v2 server's supported scopes and handles DCR, browser authorization, token exchange, local refresh, and the MCP client connection.

The previously failed Bridge version forced a single OAuth scope (`read:bitbucket:agent-interface`). That restriction is **temporarily removed with the owner's approval to prioritize connectivity**. The separate previously successful `chatgpt-mcp-tunnel` requested 40 scopes and had 21 stored granted scopes. Its actual requested scopes included write/delete/manage prefixes; the stored granted scope had none of those prefixes. **New permissions are not guaranteed to match that prior session**, so carefully review Atlassian's actual consent screen and allow only authorized workspaces/sites. The system has not proven a strict read-only security boundary.

The new local Compose service intentionally uses a **fresh named Docker volume** `atlassian-oauth-negotiated-cache`. This prevents it from silently reusing the previous Bridge client registration created with an incompatible fixed-scope request. The old failed Bridge volume and the successful `chatgpt-mcp-tunnel` volume remain untouched. Do not copy any credentials between them.

## Start the real local connection

On the trusted Linux host with the Bridge repository checked out:

```bash
cd ~/program/private/mcp-bridge-workers
git pull
npm run auth:atlassian-local:build
npm run auth:atlassian-local
```

The first command builds the local image; **the second can register a new OAuth client, display an interactive authorization URL, obtain access/refresh tokens, and save them in the new local volume.** Open the authorization URL only in a browser on that Linux host. Keep the CLI running until authorization completes. By design, the callback is `http://localhost:38678/oauth/callback` (port `38678` avoids the original tunnel's default `38677`). Do not execute either in GitHub Actions or elsewhere without checking company authorization policies.

This is an operational login path, not a request for repeated experiments. If it fails after Atlassian Accept with `invalid_request` again, **stop** rather than initiating another new DCR registration. Do not paste raw OAuth URLs, authorization codes, tokens, full CLI logs or client information into chat or the GitHub PR.

The CLI will attempt to list MCP tools/resources on success. This makes a **local** connection only; do not claim ChatGPT's Cloudflare MCP Portal is connected as a result.

## Cloudflare Portal is still a separate step

```text
Laptop / Linux host
  Browser -> mcp-remote@0.14.3 -> Atlassian Rovo MCP v2
  Local OAuth cache (separate Docker volume)

Cloudflare MCP Portal -> Cloudflare Worker -> Atlassian Rovo MCP v2
                                            ^
                                Auth handoff NOT implemented
```

The current Worker relies on `UPSTREAM_AUTHORIZATION` and does **not** read this Docker volume, implement OAuth refresh or securely receive the local OAuth session. To complete Portal connectivity, a separately designed credential mechanism (or an authenticated private local relay) must bridge that boundary. No cloud token copy/export, Worker secrets, Cloudflare deployments, org permissions or production tool allowlists were changed by this commit. A request to prioritize connectivity does not, by itself, authorize handing over the separate previously successful tunnel's token or enabling unrestricted tool mutation.

**Operational status:** Local scope negotiation now matches successful mcp-remote behavior (except separate registration/cache/port). New local login **not yet observed**; Portal-to-Worker-to-Atlassian **not yet connected**. PR #2 remains Draft until an end-to-end route actually works.

For old evidence and the read-only scope comparison, see [OAuth feasibility history](oauth-feasibility.md) and [successful tunnel scope inspection](mcp-remote-success-scope-check.md).
