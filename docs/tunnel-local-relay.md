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

The relay token file is ignored by Git and mounted directly **read-only** as `/run/secrets/relay_auth_token`; its value stays in a `0600` host file. Docker Compose file-based `secrets` cannot reliably remap UID/GID in this environment, so this direct bind avoids the failing secret mount. The trusted host file owner UID must match the container `node` UID (1000 in this pinned Node image). Confirm safely with `stat -c 'host uid=%u mode=%a' tools/local-oauth/.relay-token` and `id -u`; do not print its contents or make it world-readable. The bind explicitly sets `create_host_path: false` to avoid creating an empty directory if the token is missing. Stop it with `npm run relay:atlassian-local:stop`. Do not run a new interactive auth client concurrently with the relay. `/health` reports **liveness only**, not upstream authorization or Portal connectivity.

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

## Fixed local startup failure: unreadable Compose secret (2026-10-20)

Operator observed `Restarting (1)` and `RELAY_SECRET_NOT_READABLE` with the non-root container UID 1000. This was the local relay's failure to read the file-based Compose secret, **not an Atlassian OAuth failure**. The Compose configuration now uses a direct read-only bind mount of the existing `0600` host token, preserving UID ownership. The Node relay also emits a safe, fixed `MCP_RELAY_STARTUP_FAILED: secret_not_readable` indicator if reading still fails; it never prints secret contents or raw exception text.

**Do not regenerate `.relay-token`**, which may already be staged for Cloudflare. The file's existing contents are unchanged. After `git pull`, run:

```bash
cd ~/program/private/mcp-bridge-workers
docker compose -f tools/local-oauth/compose.mcp-remote.yaml --profile relay up -d --force-recreate relay
docker compose -f tools/local-oauth/compose.mcp-remote.yaml --profile relay ps -a
curl -i http://127.0.0.1:18787/health
```

If it still fails, use `docker compose -f tools/local-oauth/compose.mcp-remote.yaml --profile relay logs --tail=30 relay` and share **only non-secret diagnostic codes**. Missing or unreadable files are a local host permissions problem; resolve ownership instead of widening permissions.

## Fix: `EACCES` loading `/opt/mcp-relay/server.mjs` (2026-10-20)

The operator observed `Restarting (1)` and a Node.js `EACCES open /opt/mcp-relay/server.mjs`. This is **source bind-mount permission failure**, separate from the earlier private relay bearer issue. In particular, `umask 077` in an interactive Linux shell can result in new Git checkout files being inaccessible to container UID 1000. We now **COPY** `tools/local-relay/server.mjs` into the Docker image with non-root ownership and image-local mode `0444`. The host source file is no longer bind-mounted. The OAuth volume and relay bearer host file remain unchanged; there is no reason to chmod the host source tree or regenerate any token.

A default-deny `.dockerignore` prevents the `.relay-token`, `.env` files and other working-tree content from being sent to the build context; only the Dockerfile and relay source are included. CI now builds the image and verifies that the non-root runtime can read the packaged source. GitHub Actions success is not a substitute for testing the actual user's Docker host.

```bash
cd ~/program/private/mcp-bridge-workers
git pull

# REQUIRED: a plain `up -d --force-recreate` does NOT rebuild the Docker image.
docker compose -f tools/local-oauth/compose.mcp-remote.yaml \\
  --profile relay up -d --build --force-recreate relay

# Inspect only status and local liveness. No credentials are printed.
docker compose -f tools/local-oauth/compose.mcp-remote.yaml \\
  --profile relay ps -a
curl -i http://127.0.0.1:18787/health
```

If this returns another `Restarting`, inspect `logs --tail=30 relay`. If you see `MCP_RELAY_STARTUP_FAILED: secret_not_readable`, the *separate* bearer file is still not readable; check its host UID and the container's effective UID, without changing its mode or revealing its contents. Avoid `docker compose down -v` because it would remove the successful OAuth volume.
