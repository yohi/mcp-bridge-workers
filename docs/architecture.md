# Architecture (draft)

```text
ChatGPT / OpenCode
  -> Cloudflare MCP Portal (Access identity/authz)
  -> Dedicated Cloudflare Worker (/mcp + bearer auth)
  -> Fixed remote MCP upstream (provider credentials)
```

One Worker per provider, one repository. Shared `packages/core` code handles MCP HTTP relay checks. Each `workers/*` module defines a fixed upstream URL and allowed tool names, and gets its own separate secrets. MCP Portal aggregates all Workers.

The prototype is stateless. A future token store will require per-user identity mapping, application-layer encryption, rotation/revocation, refresh coordination, and least-privilege checks.

This PoC does not deploy resources, implement OAuth, or claim production readiness. Cloudflare Zero Trust Gateway inspection is independent of Workers and may have separate plan limitations.

## Local OAuth integration boundary (staged in PR #2)

The new dedicated Linux-only `mcp-remote@0.14.3` client handles local browser OAuth, including DCR and refresh, using an isolated local Docker credential volume and the same discovered/negotiated scope behavior as the successful tunnel. This new profile uses a fresh cache; its runtime has **not yet been exercised in this configuration**. Local Docker host networking does not connect the remote Cloudflare Worker to the localhost cache. The Worker continues to require a separately supplied upstream bearer value; **there is no credential handoff**. No copy/export of the previously successful chatgpt-mcp-tunnel's broader-scope OAuth token is permitted. The project must design per-user identity isolation, short-lived credential handoff, secure at-rest storage, refresh and revocation, and nested write prevention before any remote deployment. See [design and operating guide](mcp-remote-auth-adoption.md).


## Connection-first local relay route (staged)

Cloudflare MCP Portal → Worker (bearer) → Access-protected Cloudflare Tunnel (service token) → local loopback Node HTTP relay (independent bearer) → cached mcp-remote@0.14.3 (stdio) → Atlassian. OAuth tokens stay in the separate Bridge Docker volume. Only POST JSON-RPC and notifications are implemented: GET SSE, full sessions and Portal interoperability are unproved. See [runbook](tunnel-local-relay.md).
