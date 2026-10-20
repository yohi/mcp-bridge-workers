import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root=new URL('./',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const compose=read('compose.mcp-remote.yaml');
const image=read('Dockerfile.mcp-remote');

test('mcp-remote negotiates OAuth scopes as successful tunnel, without a forced read-only profile',()=>{
  assert.doesNotMatch(compose,/--static-oauth-client-metadata|--static-oauth-client-info/);
  assert.doesNotMatch(compose,/bitbucket-readonly-client\.json|read:bitbucket:agent-interface/);
  assert.doesNotMatch(compose,/--authorize-param|prompt=consent|--skip-resource/);
});
test('isolated local OAuth uses published pinned version with non-root runtime',()=>{
  assert.match(image,/npm install --global --omit=dev mcp-remote@0\.14\.3/);
  assert.match(image,/^USER node$/m);
  assert.match(compose,/image: mcp-bridge-atlassian-auth:0\.14\.3/);
  assert.match(compose,/profiles: \[auth\]/);
  assert.match(compose,/entrypoint: \["mcp-remote-client"\]/);
  assert.match(compose,/MCP_REMOTE_CONFIG_DIR: \/home\/node\/\.mcp-auth/);
});
test('same v2 endpoint and callback semantics as successful tunnel, but non-conflicting local port',()=>{
  assert.match(compose,/https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  assert.match(compose,/network_mode: host/);
  assert.match(compose,/- "38678"/);
  assert.match(compose,/- localhost/);
  assert.match(compose,/- \/oauth\/callback/);
  assert.match(compose,/- http-only/);
  assert.match(compose,/- "180"/);
});
test('new negotiated-scope cache is separate from failed Bridge and existing ChatGPT tunnel',()=>{
  assert.match(compose,/atlassian-oauth-negotiated-cache:\/home\/node\/\.mcp-auth/);
  assert.match(compose,/^  atlassian-oauth-negotiated-cache:$/m);
  assert.doesNotMatch(compose,/atlassian-oauth-cache:\/home\/node\/\.mcp-auth|oauth-data:\/home\/node\/\.mcp-auth/);
  assert.match(compose,/read_only: true/);
  assert.match(compose,/cap_drop: \[ALL\]/);
  assert.match(compose,/no-new-privileges:true/);
  assert.doesNotMatch(compose,/CONTROL_PLANE_API_KEY|UPSTREAM_AUTHORIZATION|PORTAL_BEARER_TOKEN|wrangler/);
});


test('localhost relay container shares only the new OAuth cache, uses userns-safe staged bearer and loopback listener',()=>{
  assert.match(compose,/profiles: \[relay\]/);
  assert.match(compose,/entrypoint: \["node", "\/opt\/mcp-relay\/server\.mjs"\]/);
  assert.doesNotMatch(compose,/\.\.\/local-relay\/server\.mjs:\/opt\/mcp-relay\/server\.mjs/);
  assert.match(image,/COPY --chown=node:node tools\/local-relay\/server\.mjs \/opt\/mcp-relay\/server\.mjs/);
  assert.match(image,/RUN chmod 0444 \/opt\/mcp-relay\/server\.mjs/);
  assert.match(image,/install -d -m 0755 -o node -g node \/opt\/mcp-relay/);
  assert.match(compose,/RELAY_SECRET_FILE: \/run\/relay-secrets\/token/);
  assert.match(compose,/source: \.\/\.relay-token/);
  assert.match(compose,/target: \/run\/bootstrap\/relay-token/);
  assert.match(compose,/source: relay-secret-storage\n\s+target: \/run\/relay-secrets\n\s+read_only: true/);
  assert.match(compose,/relay-secret-init:\n\s+condition: service_completed_successfully/);
  assert.match(compose,/network_mode: none/);
  assert.match(compose,/cap_add: \[CHOWN, DAC_OVERRIDE\]/);
  assert.match(compose,/install -m 0400 \/run\/bootstrap\/relay-token \/run\/relay-secrets\/\.token-next/);
  assert.match(compose,/chown 1000:1000 \/run\/relay-secrets\/\.token-next/);
  assert.match(compose,/RELAY_SECRET_STAGED_FOR_NODE/);
  assert.doesNotMatch(compose,/^\s+secrets:/m);
  assert.match(compose,/atlassian-oauth-negotiated-cache:\/home\/node\/\.mcp-auth/);
  assert.doesNotMatch(compose,/atlassian-oauth-cache:\/home\/node\/\.mcp-auth/);
});


test('Docker build context explicitly excludes local credential files',()=>{
  const ignore=read('../../.dockerignore');
  assert.match(ignore,/^\*\*$/m);
  assert.match(ignore,/^!tools\/local-relay\/server\.mjs$/m);
  assert.match(ignore,/^!tools\/local-oauth\/Dockerfile\.mcp-remote$/m);
  assert.doesNotMatch(ignore,/^!tools\/local-oauth\/\.relay-token$/m);
});


test('cloudflared runs only with opt-in tunnel profile and official pinned image',()=>{
  assert.match(compose,/cloudflared:\n\s+profiles: \[tunnel\]/);
  assert.match(compose,/cloudflare\/cloudflared:2026\.10\.1/);
  assert.match(compose,/user: "1000:1000"/);
  assert.match(compose,/--token-file\n\s+- \/run\/cloudflared-tokens\/token/);
  assert.match(compose,/--no-autoupdate/);
  assert.match(compose,/network_mode: host/);
  assert.doesNotMatch(compose,/TUNNEL_TOKEN:|--token\s+[^-]|\$\{TUNNEL_TOKEN\}/);
  assert.doesNotMatch(compose,/docker\.sock|ports:/);
});
test('tunnel token staging is offline, isolated and rootless UID-safe',()=>{
  assert.match(compose,/cloudflared-token-init:\n\s+profiles: \[tunnel\]/);
  assert.match(compose,/cloudflared-token-init:\n[\s\S]*?network_mode: none/);
  assert.match(compose,/source: \.\/\.cloudflared-token/);
  assert.match(compose,/target: \/run\/bootstrap\/tunnel-token/);
  assert.match(compose,/create_host_path: false/);
  assert.match(compose,/cap_drop: \[ALL\]/);
  assert.match(compose,/cap_add: \[CHOWN, DAC_OVERRIDE\]/);
  assert.match(compose,/install -m 0400 \/run\/bootstrap\/tunnel-token \/run\/cloudflared-tokens\/\.token-next/);
  assert.match(compose,/chown 1000:1000 \/run\/cloudflared-tokens\/\.token-next/);
  assert.match(compose,/cloudflared-token-init:\n\s+condition: service_completed_successfully/);
  assert.match(compose,/source: cloudflared-token-storage\n\s+target: \/run\/cloudflared-tokens\n\s+read_only: true/);
  assert.match(compose,/^  cloudflared-token-storage:$/m);
});
test('tunnel secret path is ignored by Git and never added to Docker build context',()=>{
  const gitignore=read('../../.gitignore');
  const buildIgnore=read('../../.dockerignore');
  assert.match(gitignore,/^tools\/local-oauth\/\.cloudflared-token$/m);
  assert.match(buildIgnore,/^\*\*$/m);
  assert.doesNotMatch(buildIgnore,/^!tools\/local-oauth\/\.cloudflared-token$/m);
});
