import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDiscovery,AS_METADATA,ISSUER,RESOURCE_METADATA} from './discovery.mjs';
import {makeOAuthChallenge,makeAuthorizationUrl,classifyCallback} from './probe-core.mjs';

const metadata = {
  issuer:ISSUER,
  authorization_endpoint:ISSUER+'/v1/authorize',
  token_endpoint:ISSUER+'/v1/token',
  registration_endpoint:ISSUER+'/v1/register',
  response_types_supported:['code'],
  grant_types_supported:['authorization_code','refresh_token'],
  code_challenge_methods_supported:['S256'],
};
function mockFetch(responses) {
  const calls=[];
  const get=async (url,options)=>{
    calls.push({url,options});
    if (!(url in responses)) return new Response('',{status:404});
    const found=responses[url];
    return found instanceof Response?found:
      new Response(JSON.stringify(found),{headers:{'content-type':'application/json'}});
  };
  return {get,calls};
}
test('root authorization-server metadata is sufficient when protected metadata is missing',async()=>{
  const {get,calls}=mockFetch({[AS_METADATA]:metadata});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'metadata_verified');
  assert.equal(r.resource_metadata,'not_confirmed');
  assert.equal(r.dcr,'advertised_only');
  assert.equal(r.pkce_s256,'advertised_only');
  assert.equal(r.localhost_redirect,'not_tested');
  assert.equal(r.worker_handoff,'not_implemented');
  assert.ok(calls.every(c=>c.options.method==='GET' && c.options.redirect==='error'));
  assert.ok(calls.every(c=>!c.options.headers.authorization));
});
test('resource discovery is independently reported',async()=>{
  const {get}=mockFetch({
    [AS_METADATA]:metadata,
    [RESOURCE_METADATA[0]]:{resource:'https://mcp.atlassian.com/v2/mcp',authorization_servers:[ISSUER]},
  });
  assert.equal((await inspectDiscovery(get)).resource_metadata,'confirmed');
});
test('root metadata missing means no DCR or redirect claims',async()=>{
  const {get}=mockFetch({});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'not_proven');
  assert.equal(r.localhost_redirect,'not_tested');
});
test('reject issuer mismatch',async()=>{
  const {get}=mockFetch({[AS_METADATA]:{...metadata,issuer:'https://evil.example'}});
  assert.equal((await inspectDiscovery(get)).result,'not_proven');
});
test('reject authorization endpoint on a different origin',async()=>{
  const {get}=mockFetch({[AS_METADATA]:{...metadata,authorization_endpoint:'https://evil.example/callback'}});
  assert.equal((await inspectDiscovery(get)).result,'not_proven');
});
test('do not advertise untrusted DCR endpoint',async()=>{
  const {get}=mockFetch({[AS_METADATA]:{...metadata,registration_endpoint:'https://evil.example/register'}});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'metadata_verified');
  assert.equal(r.dcr,'not_proven');
  assert.equal(r.registration_endpoint,null);
});
test('reject redirected metadata fetch',async()=>{
  const {get}=mockFetch({[AS_METADATA]:new Response('',{status:302,headers:{location:'https://evil.example'}})});
  assert.equal((await inspectDiscovery(get)).result,'not_proven');
});
test('S256 must be explicitly advertised',async()=>{
  const {get}=mockFetch({[AS_METADATA]:{...metadata,code_challenge_methods_supported:['plain']}});
  assert.equal((await inspectDiscovery(get)).pkce_s256,'not_proven');
});
test('PKCE challenge and state are freshly generated',()=>{
  const first=makeOAuthChallenge(), second=makeOAuthChallenge();
  assert.notEqual(first.state,second.state);
  assert.notEqual(first.verifier,second.verifier);
  assert.match(first.challenge,/^[A-Za-z0-9_-]+$/);
});
test('build loopback authorization URL without token or verifier',()=>{
  const k=makeOAuthChallenge();
  const u=new URL(makeAuthorizationUrl({endpoint:metadata.authorization_endpoint,
    clientId:'test-client',redirectUri:'http://127.0.0.1:18080/callback',
    challenge:k.challenge,state:k.state}));
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.equal(u.searchParams.get('state'),k.state);
  assert.ok(!u.toString().includes(k.verifier));
  assert.ok(!u.searchParams.has('client_secret'));
});
test('reject non-loopback redirect and external authorize endpoint',()=>{
  const k=makeOAuthChallenge();
  const opt={endpoint:metadata.authorization_endpoint,clientId:'x',
    challenge:k.challenge,state:k.state};
  assert.throws(()=>makeAuthorizationUrl({...opt,redirectUri:'https://worker.example/callback'}));
  assert.throws(()=>makeAuthorizationUrl({...opt,redirectUri:'http://localhost:80/callback'}));
  assert.throws(()=>makeAuthorizationUrl({...opt,endpoint:'https://evil.example/auth',
    redirectUri:'http://127.0.0.1:8080/callback'}));
});
test('callback never returns authorization code, and rejects state mismatch',()=>{
  const status=classifyCallback('/callback?code=SUPERSECRET&state=known','known');
  assert.equal(status,'callback_received');
  assert.ok(!status.includes('SUPERSECRET'));
  assert.equal(classifyCallback('/callback?code=SUPERSECRET&state=wrong','known'),'invalid_callback');
  assert.equal(classifyCallback('/callback?error=access_denied&state=known','known'),'oauth_error');
  assert.equal(classifyCallback('/other?code=x&state=known','known'),'invalid_callback');
});
