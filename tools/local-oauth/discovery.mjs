/**
 * Read-only, unauthenticated OAuth discovery against a pinned Atlassian host.
 * A metadata endpoint advertising DCR/PKCE is NOT proof of registration or login.
 */
export const RESOURCE = 'https://mcp.atlassian.com/v2/mcp';
export const ISSUER = 'https://mcp.atlassian.com';
export const AS_METADATA = ISSUER + '/.well-known/oauth-authorization-server';
export const RESOURCE_METADATA = [
  ISSUER + '/.well-known/oauth-protected-resource/v2/mcp',
  ISSUER + '/.well-known/oauth-protected-resource',
];

function safeEndpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.origin === ISSUER &&
      !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

async function readJson(url, get) {
  const response = await get(url, {
    method: 'GET',
    redirect: 'error',
    headers: {'accept': 'application/json'},
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('http_' + response.status);
  const type = response.headers?.get?.('content-type') || '';
  if (!type.toLowerCase().includes('json')) throw new Error('non_json');
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 65536) throw new Error('too_large');
  // All endpoints are pinned: no redirects, credentials or user-supplied URLs.
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
  return value;
}

/**
 * Returns non-sensitive metadata only. Does not register clients or authorize.
 * @param {(url:string,options:object)=>Promise<Response>} get
 */
export async function inspectDiscovery(get = fetch) {
  let resourceMetadata = 'not_confirmed';
  for (const url of RESOURCE_METADATA) {
    try {
      const document = await readJson(url, get);
      // Resource identifiers may be origin-scoped or path-scoped.
      if ((document.resource === RESOURCE || document.resource === ISSUER) &&
          Array.isArray(document.authorization_servers) &&
          document.authorization_servers.includes(ISSUER)) {
        resourceMetadata = 'confirmed';
        break;
      }
    } catch {
      // A missing resource metadata endpoint does not imply no root metadata.
    }
  }

  let metadata;
  try {
    metadata = await readJson(AS_METADATA, get);
  } catch {
    return {
      result: 'not_proven',
      resource_metadata: resourceMetadata,
      authorization_server_metadata: 'not_confirmed',
      dcr: 'not_proven',
      pkce_s256: 'not_proven',
      localhost_redirect: 'not_tested',
      token_exchange: 'not_tested',
      worker_handoff: 'not_implemented',
    };
  }

  const valid = metadata.issuer === ISSUER &&
    safeEndpoint(metadata.authorization_endpoint) &&
    safeEndpoint(metadata.token_endpoint);
  if (!valid) {
    return {
      result: 'not_proven', resource_metadata: resourceMetadata,
      authorization_server_metadata: 'invalid_or_untrusted',
      dcr: 'not_proven', pkce_s256: 'not_proven',
      localhost_redirect: 'not_tested',
      token_exchange: 'not_tested', worker_handoff: 'not_implemented',
    };
  }

  return {
    result: 'metadata_verified',
    resource_metadata: resourceMetadata,
    authorization_server_metadata: 'confirmed',
    issuer: ISSUER,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: safeEndpoint(metadata.registration_endpoint) ?
      metadata.registration_endpoint : null,
    dcr: safeEndpoint(metadata.registration_endpoint) ? 'advertised_only' : 'not_proven',
    pkce_s256: metadata.code_challenge_methods_supported?.includes('S256') ?
      'advertised_only' : 'not_proven',
    authorization_code: metadata.response_types_supported?.includes('code') &&
      metadata.grant_types_supported?.includes('authorization_code') ?
      'advertised_only' : 'not_proven',
    localhost_redirect: 'not_tested',
    token_exchange: 'not_tested',
    worker_handoff: 'not_implemented',
  };
}
