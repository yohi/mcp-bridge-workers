/**
 * Read-only OAuth metadata discovery for Atlassian Rovo MCP.
 * Does not log in, initiate consent, fetch tokens, or alter resources.
 */
const resource = 'https://mcp.atlassian.com/v2/mcp';
const resourceURL = new URL(resource);
const endpoints = [
  resourceURL.origin + '/.well-known/oauth-protected-resource' + resourceURL.pathname,
  resourceURL.origin + '/.well-known/oauth-protected-resource',
];

async function getJson(url) {
  const response = await fetch(url, {
    headers: {Accept:'application/json'}, redirect:'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}
const validUrl = (v) => {try {return new URL(v).protocol === 'https:';} catch {return false;}};
let discovered;
for (const endpoint of endpoints) {
  try {
    const doc = await getJson(endpoint);
    if (doc?.resource === resource && Array.isArray(doc.authorization_servers)) {
      discovered = {endpoint, doc};
      break;
    }
  } catch (e) {
    console.log('Not available: ' + endpoint + ' (' + e.message + ')');
  }
}
if (!discovered) {
  console.log('UNKNOWN: OAuth resource metadata not found; no conclusion about localhost.');
  process.exitCode = 2;
} else {
  console.log('Resource metadata: ' + discovered.endpoint);
  for (const issuer of discovered.doc.authorization_servers.filter(validUrl)) {
    const parsed = new URL(issuer);
    const suffix = parsed.pathname.replace(/\/$/, '');
    const candidates = [
      parsed.origin + '/.well-known/oauth-authorization-server' + suffix,
      parsed.origin + '/.well-known/openid-configuration' + suffix,
    ];
    for (const candidate of candidates) {
      try {
        const m = await getJson(candidate);
        if (m.issuer !== issuer) continue;
        console.log(JSON.stringify({
          issuer: m.issuer,
          authorization_endpoint: m.authorization_endpoint ?? null,
          token_endpoint: m.token_endpoint ?? null,
          registration_endpoint: m.registration_endpoint ?? null,
          code_challenge_methods_supported: m.code_challenge_methods_supported ?? null,
          grant_types_supported: m.grant_types_supported ?? null,
        },null,2));
        console.log('DISCOVERY ONLY: localhost redirect and Worker handoff remain unverified.');
        process.exit(0);
      } catch (e) {
        console.log('Not available: ' + candidate + ' (' + e.message + ')');
      }
    }
  }
  process.exitCode = 2;
}
