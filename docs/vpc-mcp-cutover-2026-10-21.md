# Atlassian MCP Bridge — Workers VPC cutover and rollback (2026-10-21)

## Scope and verified evidence

- Target: `atlassian-rovo-mcp-bridge`, Draft PR #2, branch `feat/atlassian-oauth-feasibility`.
- Existing published hostname / Cloudflare Access / Bot Fight Mode remain untouched.
- Current VPC Service: `atlassian-relay-private`, ID `01a15cd4-afbd-7e03-912e-22db7b459014`, fixed destination `127.0.0.1:18787` through existing `CoreUltra7-270K` Tunnel.
- Owner reports **HTTP 200, JSON-RPC result present** for both `ping` and argument-free `getAccessibleAtlassianResources` on the isolated `/mcp/vpc` route.
- These checks do **not** prove Portal's full initialize/list/call lifecycle or nested read-only semantics of `discover` and `executeRead`.

## Activation scope and invariants

The Wrangler config selects `ATLASSIAN_UPSTREAM_MODE=local_relay_vpc` for the existing `/mcp` path. **This configuration change takes effect only after operator-controlled Worker deployment.**

- `PORTAL_BEARER_TOKEN` still authenticates `/mcp` callers. No anonymous bypass.
- Existing method and tool allowlists, tools/list filtering, response header filtering and JSON-RPC handling are unchanged.
- The `ATLASSIAN_RELAY_VPC` binding targets the already registered VPC Service.
- The VPC request sends only `LOCAL_RELAY_BEARER_TOKEN` as a Bearer Authorization header; it does NOT send Cloudflare Access credentials.
- The VPC mode requires valid binding and bearer; missing dependencies give 503. Upstream 401/403, redirects, or fetch errors return 502. **No automatic fallback to the public hostname**.
- `UPSTREAM_DENIAL_DIAGNOSTICS=off` disables temporary 401/403 body classification.
- Local OAuth cache, Docker Relay, local Tunnel connector, public DNS, Access Service Auth, MCP Portal configuration, Gateway routing and CodeMode policy must not be modified as part of this cutover.
- Do not assert read-only end-to-end safety merely because `getAccessibleAtlassianResources` succeeded. `discover` and `executeRead` still need nested-operation assessment.

## Pre-deployment checks (operator machine)

1. Keep a record of previously deployed, **network-proven diagnostic baseline** commit `c5e170121aaeb622517847a1a0539f0c6b745c47`. Its `/mcp/vpc` works; its ordinary `/mcp` still uses the Bot-Fight-blocked public route.
2. Confirm `git status --short` and avoid overwriting local work.
3. Run `git pull --ff-only origin feat/atlassian-oauth-feasibility`, then `npm test`.
4. Confirm the checked-in Wrangler config contains VPC Service ID `01a15cd4-afbd-7e03-912e-22db7b459014` and `ATLASSIAN_UPSTREAM_MODE=local_relay_vpc`. No secret values should be shown or changed.
5. Deploy with `npm run deploy:atlassian` when ready for a deliberate change to `/mcp`. Do not modify the Portal server URL.

## Safe post-deployment validation

1. Repeat previously successful `GET /health/vpc` using existing Portal bearer; expect HTTP 200 with `phase=vpc-transport-only`, `status=reachable`.
2. Invoke **ordinary** `POST /mcp` (not `/mcp/vpc`) via the Worker URL, first JSON-RPC `ping`, then `tools/call` with `name=getAccessibleAtlassianResources` and `arguments={}`. Both should be HTTP 200 with `result` present and no JSON-RPC error. Print only status and booleans; do not paste any raw Atlassian payload or tokens.
3. Invoke ChatGPT Portal CodeMode `getAccessibleAtlassianResources({})` to confirm the actual Portal→Worker→VPC path; print only success/error classification, not personal resource contents.
4. Inspect Cloudflare Worker logs by status code only, to check that no newly introduced 502s or 503s appear. Do not log OAuth, Access or relay tokens.
5. Check `tools/list` filtering and denied `executeWrite`/ `executeDestructive` from synthetic tests; avoid live write-tool invocation. Never claim full nested read-only enforcement without additional review.

## Rollback — before versus after cutover

**Before deployment:** do nothing. Code changes on Draft PR do not affect the running Worker until deployment.

**If deployment fails:** stop and diagnose the deployment error. Do not rotate credentials, restart containers or change Access rules.

**If ordinary `/mcp` fails after cutover:**

- Prefer keeping the isolated working VPC diagnostic route available for investigation. Do not enable an automatic public fallback.
- To revert **configuration only** to the previously running behavior, set Wrangler `ATLASSIAN_UPSTREAM_MODE` back to `local_relay` and redeploy a reviewed configuration, or redeploy the previously known Worker version via Cloudflare version history. Preserve secrets and the VPC Service.
- **Warning:** the previous ordinary `/mcp` public route was known to return 502 due to Bot Fight Mode. This rollback restores the prior configuration, *not* a healthy production connection.
- Escalate / investigate if full MCP is still unavailable; keep Portal settings, tunnel and local OAuth untouched.

## Cleanup after confirmation

After confirming normal Portal calls through VPC, separately review removal of the temporary `/mcp/vpc`, `/health/vpc` and `MCP_UPSTREAM_DENIAL` diagnostics, plus any no-longer-needed Access credentials, without broadening permissions. Do not delete Cloudflare Access or the public hostname without a separate human decision.
