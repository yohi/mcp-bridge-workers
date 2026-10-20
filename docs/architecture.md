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
