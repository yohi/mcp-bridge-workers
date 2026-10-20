import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectDiscovery,RESOURCE,RESOURCE_METADATA_URL,AUTH_ORIGIN,
  BITBUCKET_READ_SCOPE,authorizationMetadataCandidates
} from './discovery.mjs';
import {makeOAuthChallenge,makeAuthorizationUrl,classifyCallback} from './probe-core.mjs';
import {makeReadOnlyDcrRequest} from './dcr-request.mjs';

const issuer = AUTH_ORIGIN + '/test-authority';
const metadata = {
  issuer,authorization_endpoint: AUTH_ORIGIN + '/authorize',
  token_endpoint: AUTH_ORIGIN + '/oauth/token',
  registration_endpoint: issuer + '/dcr/register',
  response_types_supported:['code'],
  grant_types_supported:['authorization_code','refresh_token'],
  code_challenge_methods_supported:['S256'],
};
const resource = {
  resource: RESOURCE,
  authorization_servers: [issuer],
  scopes_supported: [BITBUCKET_READ_SCOPE,'read:me'],
};
const asUrl = authorizationMetadataCandidates(issuer)[0];
function fakeFetcher(responseDocs) {
  const calls=[];
  const get=async (url,options)=>{
    calls.push({url,options});
    if (!(url in responseDocs)) return new Response('',{status:404});
    const data = responseDocs[url];
    return data instanceof Response ? data :
      new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  return {get,calls};
}
test('v2 protected resource metadata selects tenant-scoped Atlassian Identity issuer',async()=>{
  const {get,calls}=fakeFetcher({[RESOURCE_METADATA_URL]:resource,[asUrl]:metadata});
  const result=await inspectDiscovery(get);
  assert.equal(result.result,'metadata_verified');
  assert.equal(result.issuer,issuer);
  assert.equal(result.authorization_endpoint,AUTH_ORIGIN+'/authorize');
  assert.equal(result.dcr,'advertised_only');
  assert.equal(result.bitbucket_read_scope,'advertised_only');
  assert.equal(result.localhost_redirect,'not_tested');
  assert.ok(calls.every(x=>x.options.method==='GET' && x.options.redirect==='error'));
  assert.ok(!calls.some(x=>x.url.includes('mcp.atlassian.com/v1') ||
                           x.url === 'https://mcp.atlassian.com/.well-known/oauth-authorization-server'));
});
test('cannot fall back to v1 root metadata if v2 PRM absent',async()=>{
  const {get}=fakeFetcher({'https://mcp.atlassian.com/.well-known/oauth-authorization-server':metadata});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'not_proven');
  assert.equal(r.reason,'v2_resource_metadata_unavailable');
});
test('rejects malicious protected-resource issuer',async()=>{
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:{...resource,authorization_servers:['https://evil.example/issuer']}});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'not_proven');
  assert.equal(r.reason,'v2_authorization_server_invalid_or_ambiguous');
});
test('rejects scope list without Bitbucket access',async()=>{
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:{...resource,scopes_supported:['read:me']},[asUrl]:metadata});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'metadata_verified');
  assert.equal(r.bitbucket_read_scope,'not_proven');
});
test('rejects incorrect resource identifier',async()=>{
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:{...resource,resource:'https://mcp.atlassian.com/v1/mcp'},[asUrl]:metadata});
  assert.equal((await inspectDiscovery(get)).result,'not_proven');
});
test('rejects mismatched metadata issuer',async()=>{
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:resource,[asUrl]:{...metadata,issuer:AUTH_ORIGIN+'/other'}});
  const r=await inspectDiscovery(get);
  assert.equal(r.result,'not_proven');
});
test('rejects legacy authentication and registration endpoints',async()=>{
  for(const key of ['authorization_endpoint','registration_endpoint','token_endpoint']){
    const bad={...metadata,[key]:'https://mcp.atlassian.com/v1/authorize'};
    const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:resource,[asUrl]:bad});
    assert.equal((await inspectDiscovery(get)).result,'not_proven');
  }
});
test('rejects endpoint URL redirection and unrelated host',async()=>{
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:resource,[asUrl]:new Response('',{status:302,headers:{location:'https://evil.example'}})});
  assert.equal((await inspectDiscovery(get)).result,'not_proven');
});
test('fallback path for issuer-scoped metadata is supported without legacy issuer',async()=>{
  const urls=authorizationMetadataCandidates(issuer);
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:resource,[urls[1]]:metadata});
  assert.equal((await inspectDiscovery(get)).result,'metadata_verified');
});
test('requires PKCE S256 advertisement',async()=>{
  const {get}=fakeFetcher({[RESOURCE_METADATA_URL]:resource,[asUrl]:{...metadata,code_challenge_methods_supported:['plain']}});
  assert.equal((await inspectDiscovery(get)).pkce_s256,'not_proven');
});
test('PKCE and state are fresh',()=>{
  const a=makeOAuthChallenge(),b=makeOAuthChallenge();
  assert.notEqual(a.state,b.state);assert.notEqual(a.verifier,b.verifier);
});
test('authorize URL pins v2 resource and Bitbucket read scope, not v1',()=>{
  const a=makeOAuthChallenge();
  const params={endpoint:metadata.authorization_endpoint,clientId:'test',
    redirectUri:'http://127.0.0.1:18888/callback',challenge:a.challenge,
    state:a.state,scopes:[BITBUCKET_READ_SCOPE]};
  const u=new URL(makeAuthorizationUrl(params));
  assert.equal(u.origin,AUTH_ORIGIN);
  assert.equal(u.pathname,'/authorize');
  assert.equal(u.searchParams.get('resource'),RESOURCE);
  assert.equal(u.searchParams.get('scope'),BITBUCKET_READ_SCOPE);
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  // Explicit consent prompt failed to resolve Atlassian's post-Accept error;
  // working mcp-remote@0.14.3 did not set it. Avoid forcing it.
  assert.equal(u.searchParams.has('prompt'),false);
  assert.deepEqual(u.searchParams.get('scope').split(' '),[BITBUCKET_READ_SCOPE]);
  assert.equal(u.searchParams.has('audience'),false);
  assert.ok(!u.toString().includes(a.verifier));
});
test('authorize URL rejects v1, missing Bitbucket scope and non-loopback',()=>{
  const a=makeOAuthChallenge();
  const params={endpoint:metadata.authorization_endpoint,clientId:'test',
    redirectUri:'http://127.0.0.1:18888/callback',challenge:a.challenge,
    state:a.state,scopes:[BITBUCKET_READ_SCOPE]};
  assert.throws(()=>makeAuthorizationUrl({...params,endpoint:'https://mcp.atlassian.com/v1/authorize'}));
  assert.throws(()=>makeAuthorizationUrl({...params,scopes:['read:me']}));
  assert.throws(()=>makeAuthorizationUrl({...params,redirectUri:'https://workers.dev/callback'}));
});
test('callback checks exact state and discards code',()=>{
  assert.equal(classifyCallback('/callback?state=right&code=SECRET','right'),'callback_received');
  assert.equal(classifyCallback('/callback?state=wrong&code=SECRET','right'),'invalid_callback');
  assert.equal(classifyCallback('/callback?state=right&error=denied','right'),'oauth_error');
});

import {validatePublicRegistration} from './registration-result.mjs';

const callback='http://127.0.0.1:19091/callback';
function registered(overrides={}) {
  return {client_id:'test-id', redirect_uris:[callback],
    token_endpoint_auth_method:'none', grant_types:['authorization_code'],
    response_types:['code'], ...overrides};
}

test('public DCR may return an unused client secret; never return the secret',()=>{
  const secret='VERY_SECRET_DO_NOT_ECHO';
  const r=validatePublicRegistration(registered({client_secret:secret}),callback);
  assert.equal(r.ok,true);
  assert.equal(r.reason,'public_client_registration_accepted');
  assert.equal(r.unexpected_client_secret_ignored,true);
  assert.ok(!JSON.stringify(r).includes(secret));
});

test('public DCR without a secret is valid',()=>{
  const r=validatePublicRegistration(registered(),callback);
  assert.equal(r.ok,true);
  assert.equal(r.unexpected_client_secret_ignored,false);
});

test('a different or missing loopback redirect fails closed',()=>{
  for (const redirect_uris of [undefined,[],['http://localhost:19091/callback'],
    ['http://127.0.0.1:19092/callback']]) {
    const r=validatePublicRegistration(registered({redirect_uris}),callback);
    assert.equal(r.ok,false);
    assert.equal(r.reason,'registered_redirect_uri_mismatch');
  }
});

test('registration must preserve token_endpoint_auth_method=none',()=>{
  for(const token_endpoint_auth_method of [undefined,'client_secret_basic','client_secret_post']) {
    const r=validatePublicRegistration(registered({token_endpoint_auth_method}),callback);
    assert.equal(r.ok,false);
    assert.equal(r.reason,'registered_client_auth_method_not_none');
  }
});

test('registration requires an authorization-code-capable client',()=>{
  for(const value of [
    registered({client_id:null}),
    registered({grant_types:['client_credentials']}),
    registered({response_types:['token']}),
  ]) {
    assert.equal(validatePublicRegistration(value,callback).ok,false);
  }
});

test('invalid DCR bodies are rejected without logging source data',()=>{
  for (const obj of [null, undefined,[], 'garbled',42]) {
    const result=validatePublicRegistration(obj,callback);
    assert.equal(result.ok,false);
    assert.deepEqual(Object.keys(result).sort(),
      ['ok','reason','unexpected_client_secret_ignored'].sort());
  }
});

test('DCR request exactly pins a public-client Bitbucket Read-only registration',()=>{
  const redirectUri='http://127.0.0.1:46331/callback';
  const payload=makeReadOnlyDcrRequest(redirectUri);
  assert.deepEqual(payload,{
    client_name:'mcp-bridge-workers v2 localhost feasibility probe',
    redirect_uris:[redirectUri],
    grant_types:['authorization_code'],
    response_types:['code'],
    token_endpoint_auth_method:'none',
    scope:BITBUCKET_READ_SCOPE,
  });
  assert.equal(payload.scope.includes('write:'),false);
  assert.equal(payload.scope.includes('manage:'),false);
  assert.equal(Object.hasOwn(payload,'client_uri'),false);
  assert.equal(Object.hasOwn(payload,'software_id'),false);
  assert.equal(Object.hasOwn(payload,'software_version'),false);
  assert.equal(payload.grant_types.includes('refresh_token'),false);
});
test('DCR payload and v2 authorization URL use identical readonly scope and callback',()=>{
  const redirectUri='http://127.0.0.1:46331/callback';
  const payload=makeReadOnlyDcrRequest(redirectUri);
  const c=makeOAuthChallenge();
  const u=new URL(makeAuthorizationUrl({
    endpoint:AUTH_ORIGIN+'/authorize',
    clientId:'synthetic-client-id',
    redirectUri,
    challenge:c.challenge,
    state:c.state,
    scopes:[BITBUCKET_READ_SCOPE]
  }));
  assert.equal(u.searchParams.get('scope'),payload.scope);
  assert.equal(u.searchParams.get('redirect_uri'),payload.redirect_uris[0]);
  assert.equal(u.searchParams.get('resource'),RESOURCE);
  assert.equal(u.searchParams.get('prompt'),null);
});
test('DCR builder rejects callbacks that are not exact loopback and never logs values',()=>{
  for(const uri of ['https://example.org/callback','http://localhost:46331/callback',
    'http://127.0.0.1/callback','http://127.0.0.1:46331/other',
    'http://127.0.0.1:46331/callback?code=SENSITIVE_CODE']){
    assert.throws(()=>makeReadOnlyDcrRequest(uri),{
      message:'invalid_dcr_loopback_redirect'
    });
  }
});
