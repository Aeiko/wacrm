# Supabase deployment provenance

Based on the official **self-hosted/v0.8.4** release, commit
`189adda99d1b56da55fc5a6ee3f849354aaea92a`:
<https://github.com/supabase/supabase/tree/189adda99d1b56da55fc5a6ee3f849354aaea92a/docker>.
Upstream licensing is preserved in `LICENSE`.

`volumes/api/envoy/*` and `volumes/db/*.sql` are vendored from that commit.
The Envoy listener has one intentional security patch: access logs identify
the upstream service instead of request URLs and omit referrers, which can
contain email-verification tokens.
Other vendored inputs are unmodified. `.gitattributes` preserves LF line
endings, including on Windows.

`docker-compose.yml` is adapted from that release's Docker configuration:

- Retains its image versions, Auth, REST, Realtime, Storage, imgproxy,
  Studio, postgres-meta, Envoy, and Postgres 17 initialization.
- Uses project-scoped names and a Realtime hostname/network alias instead
  of globally fixed container names.
- Uses named volumes for database data/configuration, Storage, and Studio
  snippets/function workspace. Bind-mounted files contain configuration
  only, not persistent user data.
- Publishes API and migration access on host loopback only (8000/54322).
- Omits Edge Runtime, Supavisor, and optional analytics: WACRM does not
  require them. The upstream gateway's unused functions route has no
  backend. The app uses PostgREST's existing connection pool.
- Adds Mailpit `v1.27.10` only under the `local` profile for development
  confirmation/password-reset email capture.
- Replaces credential-shaped, commented hook examples with descriptive
  placeholders so GitHub secret scanning does not flag public example text.

The app retains its existing HS256 JWT authentication integration. Setup
creates unique random secrets and matching anon/service-role JWTs; the
latter must never be exposed to the browser. No default upstream secrets
are used. Generated API-key JWTs expire after five years; plan rotation
before expiry and rebuild the app when its public key changes.

## Updating

Review the upstream self-hosted changelog and compare the Compose file and
all vendored inputs to the **same release**, rather than independently
bumping services. Preserve the logging patch. Back up and rehearse the
upgrade/restore before changing production. A major PostgreSQL upgrade is
not an ordinary image-tag change.

See [the operating guide](../../docs/self-hosting.md),
[official Docker instructions](https://supabase.com/docs/guides/self-hosting/docker),
and [the upstream changelog](https://github.com/supabase/supabase/blob/189adda99d1b56da55fc5a6ee3f849354aaea92a/docker/CHANGELOG.md).
