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

## Fix: rootless Docker UID mapping of bind-mounted bearer (2026-10-20)

Host and container diagnostics showed **host `.relay-token` UID=1000, GID=1000, mode=0600** but **container UID=0, GID=0, mode=0600** while the relay process ran as UID=1000. The direct read-only bind therefore remains unreadable to `node`; merely matching host UID to container UID was an incorrect assumption. Do **not** change the host mode to 0644, change the relay to a privileged/root process, or regenerate the bearer.

The revised Compose defines a one-shot **`relay-secret-init`**, with `network_mode: none`, a read-only bind of the existing host token, only `CHOWN` and `DAC_OVERRIDE` capabilities, and no logging of token bytes. The init copies the token into an isolated Docker **`relay-secret-storage`** named volume, owned by container UID 1000 and mode 0400. The normal relay mounts this Docker volume **read-only** and continues running as non-root with all capabilities dropped. This creates a **second local at-rest copy in Docker's private volume**; it is not uploaded to Cloudflare, but restrict Docker host/volume access and exclude it from backups. `docker compose down -v` would destroy this and the existing OAuth volume; do not run it.

**Operator retry (no new token, no OAuth):**

```bash
cd ~/program/private/mcp-bridge-workers
git pull
docker compose -f tools/local-oauth/compose.mcp-remote.yaml \
  --profile relay up -d --force-recreate relay
docker compose -f tools/local-oauth/compose.mcp-remote.yaml \
  --profile relay ps -a
curl -i http://127.0.0.1:18787/health
```

`--build` is optional in this change; Compose, not the Docker image, contains the fix. If the one-shot helper fails, show `docker compose -f tools/local-oauth/compose.mcp-remote.yaml --profile relay ps -a` and the helper's **sanitized status/error codes**, not the bearer. On success, `relay-secret-init` should show `Exited (0)`, relay should show `Up`, and `/health` should return 200. If a custom rootless/userns Docker configuration does not allow `CHOWN`, report the failure rather than escalating the long-lived relay's privileges.

Bootstrap capability rationale: in an ordinary rootful Docker daemon, a `0600` bind-mounted file can retain the host user's UID rather than appear as UID 0. A temporary root bootstrap without `DAC_OVERRIDE` then cannot read it despite being UID 0. The isolated initializer therefore enables `CHOWN` to set ownership of the Docker-managed private volume and `DAC_OVERRIDE` to read the single read-only bind-mounted source in either mapping. It has `network_mode: none` and exits before the long-running, capability-free UID-1000 relay starts. It does not print the token value.

Bootstrap portability fix: a rootful CI Docker job found that `install -o 1000 -g 1000 -m 0400` may `chown` **before** the final `chmod`, which fails once the temporary initializer has dropped `FOWNER`. The bootstrap now creates the file with `install -m 0400` **as its current owner**, then changes ownership to UID/GID 1000 as the last metadata operation. This avoids adding `FOWNER` capability to the initializer. The final mode/UID checks remain. No actual token content is logged.

## Docker-only Cloudflare Tunnel connector (opt-in, 2026-10-20)

The operator does **not** want `cloudflared` installed on Ubuntu. The Compose file now provides an **independently opt-in** `tunnel` profile that runs Cloudflare's official `cloudflare/cloudflared:2026.10.1` Docker image. It is **not launched** by `npm run relay:atlassian-local`, by CI, or by any OAuth command. Its code and configuration are staged only; **no Cloudflare Tunnel, Access application, route or actual credentials have been created or used**.

### Dashboard configuration first

1. Create a named **remotely managed** Cloudflare Tunnel in Cloudflare Zero Trust (for example `mcp-bridge-local`). The dashboard shows the `cloudflared tunnel run --token ...` command. **Copy only the token value** into a local file; do not paste the whole command into a terminal, an issue or chat.
2. Create a Cloudflare Access **Self-hosted** application for the intended public hostname, with a **Service Auth** policy allowing only a dedicated Service Token. **No Bypass / Everyone rule.** Confirm the Access policy before exposing the published hostname.
3. Set that same Tunnel's **Published application** route to service type `HTTP`, destination `http://127.0.0.1:18787`. Because the `cloudflared` and local `relay` containers both use `network_mode: host`, `127.0.0.1` refers to the same Linux host. Do not open a public host port, mount `docker.sock`, or install any binary on the host.
4. Configure Worker secrets and Portal mapping per the earlier sections. Cloudflare Access Service Token and Worker relay bearer are **different credentials** from the Tunnel connector token.

### Store the connector token without exposing it

On the Linux host, in the Bridge repository:

```bash
cd ~/program/private/mcp-bridge-workers
git pull
umask 077
# Only if the token file does not already exist:
test ! -e tools/local-oauth/.cloudflared-token && \
  ${EDITOR:-vi} tools/local-oauth/.cloudflared-token

# Metadata only, NEVER print the file's contents.
stat -c 'uid=%u gid=%g mode=%a' tools/local-oauth/.cloudflared-token
```

In the editor paste **only the Dashboard's Tunnel connector token**, save and quit. The file is Git-ignored and excluded from Docker build context. It should be owned by the host operator with mode 0600. Do not run `openssl rand` for this token—it is **Cloudflare-issued**, not locally generated. Do not print `docker compose config` while debugging; `--quiet` is safer.

### Start and stop using Docker Compose (no host installation)

First, the local relay must remain healthy:

```bash
curl -fsS http://127.0.0.1:18787/health
```

Start **only** the cloudflared connector, which initializes its dedicated private secret volume via an offline one-shot helper:

```bash
npm run tunnel:cloudflare-local
npm run tunnel:cloudflare-local:status
```

The expected state is `cloudflared-token-init: Exited (0)` and `cloudflared: Up`. The connector is non-root UID 1000, read-only filesystem, caps dropped and `no-new-privileges`. It reads a **0400** token from its own **read-only** Docker named volume. The init copies the host token to this second local at-rest volume (offline, no token value in output). This does **not** use either the Atlassian OAuth cache or the separate `.relay-token` file.

It requires `network_mode: host` because the authenticated local relay binds **only 127.0.0.1**. This reduces network isolation: the connector shares the host network namespace but has no host Docker socket or extra network capabilities. The official image is pinned to the published version tag; the digest has not been fixed, so schedule upgrades deliberately.

Inspect Tunnel status in **Cloudflare Dashboard → Networking → Tunnels**. A running container does not prove that the Tunnel connected, Access authorized a request, or the Portal reached Atlassian. Do not share raw logs until checked for tokens and tenant details.

To stop **only the connector** (leaves relay and OAuth cache running):

```bash
npm run tunnel:cloudflare-local:stop
```

To rotate the connector token, stop the connector, update the existing local file through a trusted editor, restart with `docker compose -f tools/local-oauth/compose.mcp-remote.yaml --profile tunnel up -d --force-recreate cloudflared`; the one-shot initializer will stage the current file, and the connector will re-read it. **Do not** run `docker compose down -v`: that would delete the successful local Atlassian OAuth cache and both private Docker token volumes.
