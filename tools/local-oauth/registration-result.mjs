/**
 * RFC 7591 registration response: conservative public-client verification.
 *
 * Atlassian v2 DCR has been observed returning a client_secret even with
 * token_endpoint_auth_method = 'none'. We must not emit, store, or use the
 * secret; the server-advertised auth method and exact loopback callback govern.
 *
 * Only non-sensitive classification metadata crosses this function boundary.
 */
export function validatePublicRegistration(registration, redirectUri) {
  const invalid = (reason) => ({ok:false,reason,unexpected_client_secret_ignored:false});
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
    return invalid('malformed_registration_response');
  }
  if (typeof registration.client_id !== 'string' ||
      registration.client_id.length === 0 ||
      registration.client_id.length > 2048) {
    return invalid('missing_or_invalid_client_id');
  }
  if (!Array.isArray(registration.redirect_uris) ||
      !registration.redirect_uris.every(uri => typeof uri === 'string') ||
      !registration.redirect_uris.includes(redirectUri)) {
    return invalid('registered_redirect_uri_mismatch');
  }
  // RFC 7591: absent auth method defaults to client_secret_basic, not none.
  // Do not silently switch from a public client to a confidential client.
  if (registration.token_endpoint_auth_method !== 'none') {
    return invalid('registered_client_auth_method_not_none');
  }
  if (Array.isArray(registration.grant_types) &&
      !registration.grant_types.includes('authorization_code')) {
    return invalid('authorization_code_grant_not_registered');
  }
  if (Array.isArray(registration.response_types) &&
      !registration.response_types.includes('code')) {
    return invalid('authorization_code_response_not_registered');
  }
  return {
    ok:true,
    reason:'public_client_registration_accepted',
    // This flag contains neither the secret nor its length.
    unexpected_client_secret_ignored: Object.hasOwn(registration, 'client_secret') &&
      registration.client_secret !== null,
  };
}
