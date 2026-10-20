# Local OAuth tools

**Current supported path:** local `mcp-remote@0.14.3` integration, isolated credential volume and only `read:bitbucket:agent-interface`. The working `chatgpt-mcp-tunnel` OAuth cache is not reused. See [implementation guide](../../docs/mcp-remote-auth-adoption.md).

To build the pinned local runtime without Atlassian login:

```sh
npm run auth:atlassian-local:build
```

Only after explicit owner/company authorization for an additional OAuth client registration and login:

```sh
npm run auth:atlassian-local
```

This interactive command can perform DCR, consent, code/token exchange, refresh and local token storage. Do not copy the console output or OAuth cache to a public issue. **It does not authenticate Cloudflare Workers.**

## Archived custom DCR experiment (not an operational OAuth client)

# Local OAuth v2 feasibility (not a working auth client)

Run the new **v2** discovery process against the protected-resource metadata and Atlassian Identity issuer:

```sh
npm run check:atlassian-oauth
```

The previous root-metadata check returned a misleading `metadata_verified` while pointing at `/v1/authorize`. It is **not** v2 evidence. The updated version does not fall back to legacy OAuth.

The earlier custom DCR/PKCE experiment was retired after two post-consent failures. Its file remains for evidence and source tests, but the `probe:atlassian-localhost` npm script was removed to avoid accidentally creating new registrations. Do not invoke its `--register` flag without separately reviewing and approving a new controlled experiment.

Read [the v2 verification protocol](../../docs/oauth-feasibility.md) before executing. Never post authorization URLs, redirect query strings, IDs or credentials.

Atlassian v2 DCR may return `client_secret` even with `token_endpoint_auth_method=none`. The probe checks the returned public-client method and exact loopback URI, discards any secret, and prints only sanitized validation statuses. HTTP 2xx can create a client even if the tool reports a validation error; do not repeatedly rerun DCR.

Source-level comparison with the working `mcp-remote@0.14.3` is recorded in [the verification protocol](../../docs/oauth-feasibility.md#offline-mcp-remote-v0143-vs-bridge-dcr-request-verification-2026-10-20-jst). The ineffective `prompt=consent` experiment was reverted. Do not re-run the same probe without an approved, isolated hypothesis: each run registers another OAuth client. The pure `dcr-request.mjs` builder and local tests do not perform DCR or any network operations.
