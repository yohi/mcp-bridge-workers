# Local OAuth v2 feasibility (not a working auth client)

Run the new **v2** discovery process against the protected-resource metadata and Atlassian Identity issuer:

```sh
npm run check:atlassian-oauth
```

The previous root-metadata check returned a misleading `metadata_verified` while pointing at `/v1/authorize`. It is **not** v2 evidence. The updated version does not fall back to legacy OAuth.

After explicit organization authorization, optionally run one DCR registration and local OAuth callback experiment:

```sh
npm run probe:atlassian-localhost
```

This can create a registration at Atlassian. It requests a read-only Bitbucket scope, discards any returned authorization code, does not request access/refresh tokens and does not send credentials to Workers.

Read [the v2 verification protocol](../../docs/oauth-feasibility.md) before executing. Never post authorization URLs, redirect query strings, IDs or credentials.
