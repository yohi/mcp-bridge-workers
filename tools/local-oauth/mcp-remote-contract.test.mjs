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


test('localhost relay container shares only the new OAuth cache, uses file-backed bearer and loopback listener',()=>{
  assert.match(compose,/profiles: \[relay\]/);
  assert.match(compose,/entrypoint: \["node", "\/opt\/mcp-relay\/server\.mjs"\]/);
  assert.match(compose,/\.\.\/local-relay\/server\.mjs:\/opt\/mcp-relay\/server\.mjs:ro/);
  assert.match(compose,/RELAY_SECRET_FILE: \/run\/secrets\/relay_auth_token/);
  assert.match(compose,/source: \.\/\.relay-token/);
  assert.match(compose,/target: \/run\/secrets\/relay_auth_token/);
  assert.match(compose,/read_only: true\n\s+bind:\n\s+create_host_path: false/);
  assert.doesNotMatch(compose,/^\s+secrets:/m);
  assert.match(compose,/atlassian-oauth-negotiated-cache:\/home\/node\/\.mcp-auth/);
  assert.doesNotMatch(compose,/atlassian-oauth-cache:\/home\/node\/\.mcp-auth/);
});
