/**
 * Explicit local-only experiment. Registers one ephemeral public OAuth client,
 * observes a matching loopback redirect and DISCARDs any authorization code.
 * Never exchanges codes for tokens or forwards tokens to Cloudflare Workers.
 */
import http from 'node:http';
import {inspectDiscovery, BITBUCKET_READ_SCOPE} from './discovery.mjs';
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
    metadata.resource_metadata !== 'confirmed' ||
    metadata.dcr !== 'advertised_only' ||
    metadata.pkce_s256 !== 'advertised_only' ||
    metadata.authorization_code !== 'advertised_only' ||
    metadata.bitbucket_read_scope !== 'advertised_only') {
  throw new Error('Trusted v2 OAuth metadata, DCR, S256 or Bitbucket read scope not proven: abort');
}
const scopes = [BITBUCKET_READ_SCOPE];
const challenge = makeOAuthChallenge();
let notify;
const outcome = new Promise(resolve => {notify = resolve;});
let expectedHost;
const server = http.createServer((req,res) => {
  if (req.method !== 'GET' || req.headers.host !== expectedHost) {
    res.writeHead(404, {'cache-control':'no-store'}).end(); return;
  }
  const status = classifyCallback(req.url || '/',challenge.state);
  if (status === 'invalid_callback') {
    res.writeHead(403, {'cache-control':'no-store'}).end('Invalid callback'); return;
  }
  res.writeHead(200, {
    'content-type':'text/plain; charset=utf-8',
    'cache-control':'no-store',
    'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff',
  }).end('Loopback callback observed. No token exchanged or saved. Close this tab.');
  notify(status);
});
try {
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const port=server.address().port;
  expectedHost = '127.0.0.1:' + port;
  const redirectUri='http://' + expectedHost + '/callback';
  const response=await fetch(metadata.registration_endpoint,{
    method:'POST',redirect:'error',
    headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({
      client_name:'mcp-bridge-workers v2 localhost feasibility probe',
      redirect_uris:[redirectUri],
      grant_types:['authorization_code'],
      response_types:['code'],
      token_endpoint_auth_method:'none',
      scope:scopes.join(' '),
    }),
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok) {
    // Do not log upstream body: it might include sensitive tenant or credential data.
    console.log('V2_DCR_NOT_CONFIRMED: HTTP ' + response.status);
    process.exitCode=3;
  } else {
    const registered=await response.json();
    if (typeof registered.client_id !== 'string' || !registered.client_id ||
        (registered.redirect_uris && !registered.redirect_uris.includes(redirectUri)) ||
        registered.client_secret) {
      console.log('V2_DCR_INVALID_RESPONSE: exact callback registration not confirmed');
      process.exitCode=3;
    } else {
      console.log('V2_DCR_ACCEPTED: registration response included a client ID.');
      console.log('Open the following URL in a LOCAL browser. Never share or log it.');
      console.log(makeAuthorizationUrl({
        endpoint:metadata.authorization_endpoint,clientId:registered.client_id,
        redirectUri,challenge:challenge.challenge,state:challenge.state,scopes,
      }));
      const timer=setTimeout(()=>notify('timeout'),timeoutSeconds*1000);
      const result=await outcome;
      clearTimeout(timer);
      if (result === 'callback_received') {
        console.log('V2_LOCALHOST_CALLBACK_CONFIRMED: state matched; code discarded.');
      } else {
        console.log(result === 'oauth_error' ?
          'V2_LOCALHOST_OAUTH_ERROR: browser returned OAuth error.' :
          'V2_LOCALHOST_NOT_CONFIRMED: no callback before timeout.');
        process.exitCode=4;
      }
      console.log('TOKEN_EXCHANGE_NOT_TESTED; WORKER_HANDOFF_NOT_IMPLEMENTED.');
    }
  }
} finally {
  server.close();
}
