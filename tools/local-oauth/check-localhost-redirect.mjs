/**
 * Explicit opt-in experiment. Registers an ephemeral public OAuth client,
 * waits for the browser's loopback redirect, and discards any auth code.
 * No token exchange and no Worker handoff. NO auto-run in CI.
 */
import http from 'node:http';
import {inspectDiscovery} from './discovery.mjs';
import {makeOAuthChallenge,makeAuthorizationUrl,classifyCallback} from './probe-core.mjs';

const args = process.argv.slice(2);
if (!args.includes('--register')) {
  console.error('No operation performed. To explicitly opt into DCR and browser consent:');
  console.error('  node tools/local-oauth/check-localhost-redirect.mjs --register');
  process.exit(2);
}
const timeoutArg = args.find(a => a.startsWith('--timeout-seconds='));
const timeoutSeconds = timeoutArg ? Number(timeoutArg.split('=')[1]) : 120;
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300) {
  throw new Error('timeout must be between 30 and 300 seconds');
}
const metadata = await inspectDiscovery();
if (metadata.result !== 'metadata_verified' ||
    metadata.dcr !== 'advertised_only' || metadata.pkce_s256 !== 'advertised_only') {
  throw new Error('DCR or S256 not advertised by trusted metadata; abort');
}
const challenge = makeOAuthChallenge();
let notify;
const outcome = new Promise(resolve => {notify = resolve;});
let expectedHost;
const server = http.createServer((req,res) => {
  if (req.method !== 'GET' || req.headers.host !== expectedHost) {
    res.writeHead(404, {'cache-control':'no-store'}).end();
    return;
  }
  const status = classifyCallback(req.url || '/', challenge.state);
  if (status === 'invalid_callback') {
    res.writeHead(403, {'cache-control':'no-store'}).end('Invalid callback');
    return;
  }
  res.writeHead(200, {
    'content-type':'text/plain; charset=utf-8',
    'cache-control':'no-store',
    'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff',
  }).end('OAuth loopback callback observed. No token was exchanged or saved. You can close this tab.');
  notify(status);
});
try {
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const port = server.address().port;
  expectedHost = '127.0.0.1:' + port;
  const redirectUri = 'http://' + expectedHost + '/callback';

  // The registration endpoint is discovered from trusted issuer metadata.
  // Explicit user-run registration creates a client on Atlassian's side.
  const response = await fetch(metadata.registration_endpoint,{
    method:'POST',
    redirect:'error',
    headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({
      client_name:'mcp-bridge-workers localhost feasibility probe',
      redirect_uris:[redirectUri],
      grant_types:['authorization_code'],
      response_types:['code'],
      token_endpoint_auth_method:'none',
    }),
    signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // Never log upstream bodies: they may include IDs, tenant details or secrets.
    console.log('DCR_NOT_CONFIRMED: HTTP ' + response.status);
    process.exitCode = 3;
  } else {
    const registered = await response.json();
    if (typeof registered.client_id !== 'string' || registered.client_id.length === 0 ||
        (registered.redirect_uris &&
          !registered.redirect_uris.includes(redirectUri))) {
      console.log('DCR_INVALID_RESPONSE: cannot confirm exact callback registration');
      process.exitCode = 3;
    } else {
      console.log('DCR_ACCEPTED: registration response included a client ID.');
      console.log('Use a LOCAL browser to complete interactive consent. Do not copy this URL to logs.');
      console.log(makeAuthorizationUrl({
        endpoint:metadata.authorization_endpoint,
        clientId:registered.client_id, redirectUri,
        challenge:challenge.challenge, state:challenge.state,
      }));
      const timer = setTimeout(()=>notify('timeout'),timeoutSeconds*1000);
      const result = await outcome;
      clearTimeout(timer);
      if (result === 'callback_received') {
        console.log('LOCALHOST_CALLBACK_CONFIRMED: exact state matched; auth code discarded.');
      } else {
        console.log(result === 'oauth_error' ?
          'LOCALHOST_OAUTH_ERROR: browser returned OAuth error.' :
          'LOCALHOST_NOT_CONFIRMED: callback not received before timeout.');
        process.exitCode = 4;
      }
      console.log('TOKEN_EXCHANGE_NOT_TESTED; WORKER_HANDOFF_NOT_IMPLEMENTED.');
    }
  }
} finally {
  server.close();
}
