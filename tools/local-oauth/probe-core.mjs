import {randomBytes, createHash} from 'node:crypto';
import {RESOURCE, ISSUER} from './discovery.mjs';

export function makeOAuthChallenge() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    state: randomBytes(24).toString('base64url'),
  };
}

export function makeAuthorizationUrl({endpoint, clientId, redirectUri, challenge, state}) {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.origin !== ISSUER || endpointUrl.protocol !== 'https:' ||
      !clientId || !challenge || !state ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/callback$/.test(redirectUri)) {
    throw new Error('unsafe_authorization_parameters');
  }
  const url = new URL(endpoint);
  url.searchParams.set('response_type','code');
  url.searchParams.set('client_id',clientId);
  url.searchParams.set('redirect_uri',redirectUri);
  url.searchParams.set('code_challenge_method','S256');
  url.searchParams.set('code_challenge',challenge);
  url.searchParams.set('state',state);
  url.searchParams.set('resource',RESOURCE);
  return url.toString();
}

/** Never return, log or store the authorization code. */
export function classifyCallback(callbackUrl, expectedState) {
  const url = new URL(callbackUrl, 'http://127.0.0.1');
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== expectedState) {
    return 'invalid_callback';
  }
  if (url.searchParams.has('error')) return 'oauth_error';
  return typeof url.searchParams.get('code') === 'string' &&
    url.searchParams.get('code').length > 0 ?
    'callback_received' : 'invalid_callback';
}
