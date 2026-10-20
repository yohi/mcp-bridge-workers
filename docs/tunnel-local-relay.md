# Cloudflare Portal → Worker → Tunnel → local mcp-remote

**Not deployed.** The owner has already succeeded with the separate local `mcp-remote-client@0.14.3` OAuth login and `tools/list` on Atlassian Rovo MCP v2. Its later `resources/list` -32601 is an unsupported optional MCP method; `Exiting OK` means the auth diagnostic completed. None of that proves Portal→Worker connectivity.

## Connectivity design

```
Cloudflare MCP Portal (one authorized caller, Portal bearer)
  -> Worker /mcp (validates PORTAL_BEARER_TOKEN)
  -> HTTPS hostname protected by Cloudflare Access Service Auth
     (CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET)
  -> Named Cloudflare Tunnel / cloudflared on the Linux host
  -> http://127.0.0.1:18787/mcp
     (local server verifies independent LOCAL_RELAY_BEARER_TOKEN)
  -> stdio mcp-remote@0.14.3 with the already cached OAuth session
  -> Atlassian Rovo MCP v2
```

The Atlassian OAuth tokens remain in the local **mcp-bridge-workers** Docker named volume. No token export, copying to Worker secrets, or reuse of the unrelated `chatgpt-mcp-tunnel` volume.

## 1. Local Linux host (operator-controlled)

```bash
cd ~/program/private/mcp-bridge-workers
git pull
npm install --ignore-scripts --no-audit --no-fund
npm test

# New independent relay bearer; not the Atlassian OAuth token.
umask 077
openssl rand -hex 32 > tools/local-oauth/.relay-token

# Starts the HTTP→stdio relay using the ALREADY logged-in Bridge cache.
npm run relay:atlassian-local
curl -i http://127.0.0.1:18787/health
```

The relay token file is ignored by Git and mounted through Compose secrets; preserve its confidentiality. It must be readable by the `node` UID inside the Linux container; do not make it world-readable as a workaround. Stop it with `npm run relay:atlassian-local:stop`. Do not run a new interactive auth client concurrently with the relay. `/health` reports **liveness only**, not upstream authorization or Portal connectivity.

## 2. Cloudflare Tunnel and Access (manual, not executed)

In Cloudflare's dashboard, create a **named Tunnel** with a published hostname (for example, `atlassian-relay.example.com`) pointing to **`http://127.0.0.1:18787`** on the same trusted Linux machine running `cloudflared`. Use a Cloudflare Access **self-hosted application** on that hostname, with a **Service Auth** policy allowing only the Worker's service token. Do not configure a public Bypass rule or expose port 18787 directly to the internet.

Create a dedicated Access service token and keep its Client ID and Secret private.

Docs: [Tunnel routing](https://developers.cloudflare.com/tunnel/concepts/routing/) and [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## 3. Cloudflare Worker configuration (manual, not executed)

`workers/atlassian/wrangler.jsonc` pins `ATLASSIAN_UPSTREAM_MODE=local_relay`. The Worker **fails closed** if the relay URL, bearer or Access credentials are absent, rather than falling back to direct Atlassian.

Set these five Worker secrets (do not check them into Git):

- `PORTAL_BEARER_TOKEN`: independent strong bearer expected from the Cloudflare MCP Portal.
- `LOCAL_RELAY_BEARER_TOKEN`: must exactly match `tools/local-oauth/.relay-token`, with no trailing newline.
- `LOCAL_RELAY_ORIGIN`: HTTPS hostname, e.g. `https://atlassian-relay.example.com/`. Worker constructs fixed `/mcp`; caller cannot change destination.
- `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: Access Service Auth token configured for the Tunnel hostname.

Typical Wrangler usage, from the repository root:

```bash
npx wrangler secret put PORTAL_BEARER_TOKEN --config workers/atlassian/wrangler.jsonc
printf %s "$(cat tools/local-oauth/.relay-token)" | \
  npx wrangler secret put LOCAL_RELAY_BEARER_TOKEN --config workers/atlassian/wrangler.jsonc
npx wrangler secret put LOCAL_RELAY_ORIGIN --config workers/atlassian/wrangler.jsonc
npx wrangler secret put CF_ACCESS_CLIENT_ID --config workers/atlassian/wrangler.jsonc
npx wrangler secret put CF_ACCESS_CLIENT_SECRET --config workers/atlassian/wrangler.jsonc
```

These commands mutate Cloudflare secrets and have **not** been run by the assistant. Review your installed Wrangler version and correct target account before executing them. After the human explicitly approves deployment, `npm run deploy:atlassian` deploys the Worker. Then register its `/mcp` URL in the Cloudflare MCP Portal with the separate Portal bearer; restrict access to one caller.

## Limitations and exit gates

- This is a **single-user, experimental POST JSON-RPC** bridge. It acknowledges notifications and remaps concurrent JSON-RPC request IDs. It does not currently support GET SSE, resource listing, full MCP sessions, sampling, elicitation or server-initiated notifications. Portal compatibility is NOT PROVEN.
- The Worker still restricts top-level tool names via its existing allowlist. Nested operations of `executeRead` are not proved read-only; OAuth scope discovery can include permissions broader than Bitbucket.
- If the local PC, `cloudflared`, Access policy or local cached OAuth session is unavailable, the Portal route will fail.
- OAuth success and offline unit tests are **not** proof of Cloudflare Portal end-to-end connectivity. No deployment, DCR, Cloudflare configuration or external secrets have been changed by this implementation.
