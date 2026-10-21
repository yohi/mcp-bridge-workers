/**
 * Explicit v2 localhost feasibility registration payload (RFC 7591).
 * Stable, minimal, Bitbucket Read-only. Source-level comparison with
 * mcp-remote@0.14.3 is documented; its broader scope is NOT copied.
 * No network or credentials in this module.
 */
import {BITBUCKET_READ_SCOPE} from './discovery.mjs';

export function makeReadOnlyDcrRequest(redirectUri) {
  if (typeof redirectUri !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/callback$/.test(redirectUri)) {
    throw new Error('invalid_dcr_loopback_redirect');
  }
  return {
    client_name: 'mcp-bridge-workers v2 localhost feasibility probe',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: BITBUCKET_READ_SCOPE,
  };
}
