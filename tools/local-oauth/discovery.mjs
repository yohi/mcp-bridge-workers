/**
 * Strict, unauthenticated Atlassian Rovo MCP v2 OAuth metadata discovery.
 * Never fall back to the legacy mcp.atlassian.com root issuer.
 * Does not register clients or obtain credentials.
 */
export const RESOURCE = 'https://mcp.atlassian.com/v2/mcp';
export const RESOURCE_METADATA_URL =
  'https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp';
export const AUTH_ORIGIN = 'https://auth.atlassian.com';
export const BITBUCKET_READ_SCOPE = 'read:bitbucket:agent-interface';

const notProven = (reason) => ({
  result: 'not_proven',
  reason,
  resource_metadata: 'not_confirmed',
  authorization_server_metadata: 'not_confirmed',
  dcr: 'not_proven',
  pkce_s256: 'not_proven',
  bitbucket_read_scope: 'not_proven',
  localhost_redirect: 'not_tested',
  token_exchange: 'not_tested',
  worker_handoff: 'not_implemented',
});

function isAllowedIssuer(value) {
  try {
    const url = new URL(value);
    return url.origin === AUTH_ORIGIN && url.protocol === 'https:' &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isTrustedEndpoint(value, expectedPath) {
  try {
    const u = new URL(value);
    return u.origin === AUTH_ORIGIN && u.protocol === 'https:' &&
      u.pathname === expectedPath && !u.username && !u.password &&
      !u.search && !u.hash;
  } catch { return false; }
}

function matchesRegistration(value, issuer) {
  try {
    const u = new URL(value);
    const prefix = new URL(issuer).pathname.replace(/\/$/, '');
    return u.origin === AUTH_ORIGIN && u.pathname === prefix + '/dcr/register' &&
      !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

export function authorizationMetadataCandidates(issuer) {
  if (!isAllowedIssuer(issuer)) return [];
  const url = new URL(issuer);
  const prefix = url.pathname.replace(/\/$/, '');
  return [
    // RFC 8414 path insertion.
    AUTH_ORIGIN + '/.well-known/oauth-authorization-server' + prefix,
    // Atlassian Identity also documents discovery nested under its issuer.
    AUTH_ORIGIN + prefix + '/.well-known/oauth-authorization-server',
  ];
}

async function readJson(url, get) {
  const response = await get(url, {
    method: 'GET', redirect: 'error', headers: {accept: 'application/json'},
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('http_' + response.status);
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('json')) {
    throw new Error('non_json');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 65536) throw new Error('too_large');
  // Cap bytes independently of Content-Length; avoid malicious large documents.
  const stream = response.body?.getReader();
  if (!stream) throw new Error('no_body');
  const chunks = []; let total = 0;
  while (true) {
    const {done, value} = await stream.read();
    if (done) break;
    total += value.length;
    if (total > 65536) {await stream.cancel(); throw new Error('too_large');}
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let pos = 0;
  for (const part of chunks) {bytes.set(part,pos);pos += part.length;}
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('invalid_metadata');
  return doc;
}

/**
 * Return only non-sensitive public metadata.
 * Fail closed if the v2 protected resource metadata is unavailable/invalid.
 */
export async function inspectDiscovery(get = fetch) {
  let prm;
  try {prm = await readJson(RESOURCE_METADATA_URL, get);}
  catch {return notProven('v2_resource_metadata_unavailable');}
  if (prm.resource !== RESOURCE || !Array.isArray(prm.authorization_servers)) {
    return notProven('v2_resource_metadata_invalid');
  }
  const issuers = prm.authorization_servers.filter(isAllowedIssuer);
  if (issuers.length !== 1 || issuers.length !== prm.authorization_servers.length) {
    return notProven('v2_authorization_server_invalid_or_ambiguous');
  }
  const issuer = issuers[0];
  const scopes = Array.isArray(prm.scopes_supported) ? prm.scopes_supported : [];
  if (!scopes.every(s=>typeof s === 'string')) return notProven('scopes_invalid');

  let metadata;
  for (const url of authorizationMetadataCandidates(issuer)) {
    try {
      const doc = await readJson(url, get);
      if (doc.issuer === issuer) {metadata = doc; break;}
    } catch { /* Try the next issuer-scoped well-known location only. */ }
  }
  if (!metadata) return {...notProven('v2_authorization_server_metadata_unavailable'),
    resource_metadata: 'confirmed', issuer};
  if (!isTrustedEndpoint(metadata.authorization_endpoint, '/authorize') ||
      !isTrustedEndpoint(metadata.token_endpoint, '/oauth/token') ||
      !matchesRegistration(metadata.registration_endpoint, issuer)) {
    return {...notProven('v2_authorization_server_metadata_invalid'),
      resource_metadata: 'confirmed', authorization_server_metadata: 'invalid', issuer};
  }

  const dcr = 'advertised_only';
  const pkce = metadata.code_challenge_methods_supported?.includes('S256') ?
    'advertised_only' : 'not_proven';
  const bitbucket = scopes.includes(BITBUCKET_READ_SCOPE) ?
    'advertised_only' : 'not_proven';

  return {
    result: 'metadata_verified',
    resource_metadata: 'confirmed',
    authorization_server_metadata: 'confirmed',
    resource: RESOURCE, issuer,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: metadata.registration_endpoint,
    dcr, pkce_s256: pkce,
    bitbucket_read_scope: bitbucket,
    authorization_code: metadata.response_types_supported?.includes('code') &&
      metadata.grant_types_supported?.includes('authorization_code') ?
      'advertised_only' : 'not_proven',
    // Do not report an authorized Bitbucket session simply from metadata.
    localhost_redirect: 'not_tested', token_exchange: 'not_tested',
    worker_handoff: 'not_implemented',
  };
}
