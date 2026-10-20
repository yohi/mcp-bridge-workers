# Local OAuth research (not a working login tool)

`check-oauth-discovery.mjs` performs unauthenticated discovery of official OAuth metadata only. It cannot establish whether an Atlassian organization allows localhost OAuth redirects, and it does not start login, store tokens, or transmit credentials.

A PKCE local callback helper and safe code/token handoff to Cloudflare Workers remain unimplemented pending verification of the official OAuth and organization policy.
