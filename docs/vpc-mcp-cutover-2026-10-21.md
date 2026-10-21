# Atlassian MCP — VPC cutover, verification, cleanup and rollback

## State and immutable routing references

- Cloudflare Worker: `atlassian-rovo-mcp-bridge`
- GitHub Draft PR: [#2](https://github.com/yohi/mcp-bridge-workers/pull/2), `feat/atlassian-oauth-feasibility`
- VPC binding: `ATLASSIAN_RELAY_VPC`
- VPC Service: `atlassian-relay-private`, `01a15cd4-afbd-7e03-912e-22db7b459014`
- Existing Tunnel: `CoreUltra7-270K`; fixed private destination: `127.0.0.1:18787` (HTTP)
- Required mode: `ATLASSIAN_UPSTREAM_MODE=local_relay_vpc`
- Zone Bot Fight Mode: ON; existing Access-protected hostname remains configured but is not the active upstream.

## Runtime verified on 2026-10-21 JST

1. QUIC was established on the existing healthy Docker cloudflared connector.
2. Owner invoked `GET /health/vpc` with existing Portal Bearer and received HTTP 200 / `status=reachable`.
3. Owner invoked isolated VPC `POST /mcp/vpc` `ping` and argument-free `getAccessibleAtlassianResources`, both HTTP 200 with JSON-RPC `result`. This endpoint was diagnostic only.
4. After deploying the first VPC cutover, Cloudflare API read back `local_relay_vpc` and the expected binding. ChatGPT MCP Portal CodeMode executed `getAccessibleAtlassianResources({})` without the previous 502. Bot Fight Mode remained ON.

This supports a functional transport and one read-only tool, **not** nested read-only operations or full MCP feature coverage.

## PR cleanup (separate staged deployment)

The PR finalization removes `/mcp/vpc` (the temporary tool-invocation probe) and the `MCP_UPSTREAM_DENIAL` temporary Cloudflare HTML challenge inspection. The authenticated `/health/vpc` is retained as an operational network liveness check; it never returns Relay headers or body.

The PR finalization **defaults `discover` and `executeRead` to blocked** at both `tools/list` and `tools/call` using `ATLASSIAN_UNVERIFIED_READ_TOOLS=off`. An explicit opt-in is available only pending a separate nested-operation and effective-scope review; do not enable as routine cleanup.

Source and CI are **not evidence that the updated PR has already been deployed**. After the cleanup deploy the Portal registry may need a refresh/resync to drop stale tool definitions.

## Operator release checklist (no automatic deploy)

```sh
cd ~/program/private/mcp-bridge-workers
git status --short   # Preserve existing uncommitted user files
git pull --ff-only origin feat/atlassian-oauth-feasibility
npm test
npm run deploy:atlassian
```

Use existing credentials. Do not create or rotate tokens, restart Docker, change Access or Gateway policies, delete Tunnel, or change OAuth scope.

After deploy, verify:
1. `/health/vpc` returns 200 with `status=reachable` under the existing Portal Bearer.
2. Actual ChatGPT Portal CodeMode `getAccessibleAtlassianResources({})` succeeds (do not display resource IDs).
3. Cloudflare Worker settings report `ATLASSIAN_UPSTREAM_MODE=local_relay_vpc`, `ATLASSIAN_UNVERIFIED_READ_TOOLS=off`, and the expected `ATLASSIAN_RELAY_VPC` binding.
4. MCP Portal `tools/list` shows **only** `atlassianUserInfo` and `getAccessibleAtlassianResources`; no write/destructive, `discover` or `executeRead`. If Portal caches stale tools, resync its registry without changing security policy.
5. Negative permission tests in CI pass; **do not live-call** `executeWrite`, `executeDestructive` or unverified nested tools to prove a denial.
6. Human Owner decides whether reduced capability is acceptable before making PR Ready / merging.

## Rollback

- **Before cleanup deploy:** the working VPC cutover remains active. No rollback is necessary.
- **After cleanup deploy, if connectivity fails:** restore the **last verified VPC Worker version**, not the old public Access route. Prefer Cloudflare Worker version history or a reviewed redeployment of the previously proven commit `f40c630582e9d64705dabe2defa2e8038b319f5c` (keeping the same VPC binding, secrets and local host settings).
- **Caution:** restoring that version also re-exposes the four-tool allowlist, including currently unverified `discover` / `executeRead`. Treat it as a conscious temporary trade-off, not a security-equivalent rollback.
- Restoring `ATLASSIAN_UPSTREAM_MODE=local_relay` instead returns to a **known failing** public hostname (Bot Fight Mode HTTP 403); it is not service recovery.
- On errors, stop and inspect sanitized HTTP statuses. Do not print bearer, OAuth or Access secrets.

## Remaining governance items

PR #2 started as an OAuth feasibility probe and grew into an operator-deployed Docker/Cloudflare VPC integration. It includes historical artifacts. [README](../README.md), [Security](security.md) and the PR body now distinguish live proof from staged cleanup. The PR remains Draft pending the new deployment and security trade-off decision; do not silently merge.
