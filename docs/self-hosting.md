# Self-hosting WACRM and Supabase

This setup runs Supabase locally or as a separate Dokploy Compose project;
WACRM can run on the host in development or in its own app container.
The backend is pinned to Supabase `self-hosted/v0.8.4`, upstream commit
`189adda99d1b56da55fc5a6ee3f849354aaea92a` (see
[`deploy/supabase/UPSTREAM.md`](../deploy/supabase/UPSTREAM.md)).
This is an operating guide, not a claim that production is deployed. A
production domain and SMTP provider still need to be configured. No cloud
Supabase migration has been performed.

The application has been updated to Next.js `16.4.6`; its dependency audit
has no high/critical findings. See [the security review](dependency-security.md)
for remaining tooling advisories and the separate optional MCP server audit.
Recheck dependencies and deployment security before exposing production.

## Local quickstart

Prerequisites: Node.js >=22.12.0, npm (package pin: 10.9.9), Docker with
Compose v2, and available ports 3000, 8000, 8025, and 54322. Run from the
repository root:

```bash
npm ci
npm run supabase:init
npm run supabase:up
npm run supabase:migrate -- --dry-run
npm run supabase:migrate
npm run supabase:verify
npm run dev
```

`supabase:init` generates matching fresh backend/app credentials in
`deploy/supabase/.env` and `.env.local`, without printing secrets. It refuses
if **either file already exists**. Preserve existing secrets; use a fresh
checkout for a separate installation rather than deleting a live env file.
Never run the backend with `.env.example` placeholders.

| Service                     | Local URL / connection                      |
| --------------------------- | ------------------------------------------- |
| WACRM                       | <http://localhost:3000>                     |
| Supabase API and Studio     | <http://localhost:8000>                     |
| Mailpit inbox               | <http://localhost:8025>                     |
| Postgres (migration access) | `127.0.0.1:54322`, database/user `postgres` |

Studio uses HTTP basic auth: read `DASHBOARD_USERNAME` and the generated
`DASHBOARD_PASSWORD` privately from `deploy/supabase/.env`. These are not
WACRM user credentials. Sign up in WACRM and open the confirmation email in
Mailpit. The helper starts the `local` profile, including Mailpit; SMTP goes
to `mail:1025`. It also enables `WHATSAPP_TEMPLATES_DRY_RUN=true` and uses a
placeholder Meta secret: this is not a working WhatsApp integration.

Use `npm run supabase:status` to inspect services and
`npm run supabase:down` to stop them without deleting named volumes. The app
container does not apply migrations. For a containerized app, follow
[the Docker guide](docker.md), but replace the localhost Supabase URL with a
public DNS name reachable from both the browser and container first:
`localhost` inside the app container is the app itself, not the host backend.

## Production: two Dokploy Compose projects

Use **Docker Compose**, not Docker Stack. Keep the backend and app separate
so app releases do not recreate the database. Generate a new production env
pair with `npm ci` and `npm run supabase:init` in an independent, protected
checkout; do not reuse development credentials or commit generated files.
Keep an encrypted backup of that pair.

### 1. Supabase project

- Source this repository; Compose path: `deploy/supabase/docker-compose.yml`,
  with the tracked `deploy/supabase/docker-compose.dokploy.yml` overlay and
  Advanced → Command below. Keep the existing Compose project name.
- Copy the contents of the independently generated `deploy/supabase/.env`
  into this project's Dokploy **Environment** field. Dokploy writes `.env`
  beside the Compose file; `${...}` references inject the required values.
- Do **not** enable the `local` profile in production. The npm `supabase:up`
  wrapper always enables Mailpit, so do not use it to start production;
  deploy via Dokploy instead. Edge Runtime and Supavisor are not included.
- Set production URLs, redirect policy, and real SMTP before use:

  ```dotenv
  SUPABASE_PUBLIC_URL=https://api.example.com
  API_EXTERNAL_URL=https://api.example.com/auth/v1
  SITE_URL=https://crm.example.com
  ADDITIONAL_REDIRECT_URLS=https://crm.example.com/auth/callback
  ```

  Replace these example domains. Explicitly allow any other redirect URLs
  your flows require; avoid broad wildcard allowlists. Set `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, and
  `SMTP_SENDER_NAME` for your provider; `mail` is local-only. Keep email
  confirmation enabled and decide whether public signup should be disabled
  (`DISABLE_SIGNUP`). See [auth emails](auth-emails.md).

- Route the API hostname over HTTPS to service `api-gw`, internal port
  **8000**, preserving request paths and WebSocket upgrades. Do not strip
  `/auth/v1`, `/rest/v1`, `/storage/v1`, or `/realtime/v1`.
- Check Dokploy's **Preview Compose**: the gateway must retain the backend
  default network to reach its services as well as its proxy network.
  Prefer isolated deployments or explicitly preserve both networks.

#### Required: stable configuration mounts

**Do not deploy the repository bind mounts unchanged in Dokploy.** Its
[official mount guidance](https://docs.dokploy.com/docs/core/troubleshooting/volumes-mounts)
requires copying repository inputs to Advanced → Mounts → **File Mount**;
recloning can invalidate even read-only mounts. File Mounts create files
under the project's persistent `files/` directory; they do not automatically
replace the Compose volume sources.

Create one File Mount for each of the following files. Copy the exact
contents from `deploy/supabase/volumes/` at the pinned version, using these
File Paths (relative to Dokploy's `files/`, not container paths):

- `supabase/api/envoy/envoy.yaml`
- `supabase/api/envoy/cds.yaml`
- `supabase/api/envoy/lds.template.yaml`
- `supabase/api/envoy/docker-entrypoint.sh`
- `supabase/db/realtime.sql`
- `supabase/db/webhooks.sql`
- `supabase/db/roles.sql`
- `supabase/db/jwt.sql`
- `supabase/db/_supabase.sql`
- `supabase/db/logs.sql`
- `supabase/db/pooler.sql`

The last two SQL files remain official database bootstrap inputs even
though logging/pooler services are not included. Keep `${...}` placeholders
in gateway templates literal; do not paste credentials into these files.

These are the only **11 File Mounts** required. The tracked
[`deploy/supabase/docker-compose.dokploy.yml`](../deploy/supabase/docker-compose.dokploy.yml)
replaces their sources by **container target**, preserving named data
volumes and the default network. It also removes API/database host-port
publishing with `!reset` (Compose v2.24.4+), avoiding shared-server port
conflicts. Do not create an extra overlay File Mount.
If upgrading from the old manual `supabase-mounts.yml` recipe, stop
referencing that file and use the tracked overlay instead.

Use this backend Advanced → Command as a **single line**, replacing every
`YOUR_BACKEND_PROJECT` with Dokploy's existing project name. Dokploy prefixes
`docker` to the first command; subsequent commands must start with
`docker compose`:

```text
compose -p YOUR_BACKEND_PROJECT --project-directory . --env-file deploy/supabase/.env -f deploy/supabase/docker-compose.yml -f deploy/supabase/docker-compose.dokploy.yml up -d --wait --wait-timeout 240 && docker compose -p YOUR_BACKEND_PROJECT --project-directory . --env-file deploy/supabase/.env -f deploy/supabase/docker-compose.yml -f deploy/supabase/docker-compose.dokploy.yml run --rm migrate && docker compose -p YOUR_BACKEND_PROJECT --project-directory . --env-file deploy/supabase/.env -f deploy/supabase/docker-compose.yml -f deploy/supabase/docker-compose.dokploy.yml run --rm verify
```

The `maintenance` profile keeps `migrate` and `verify` out of ordinary
`up`; explicitly targeting them with `run` activates each job without a
profile flag. Do not enable `maintenance` globally or combine both jobs in
`up`. The chain waits for backend health, applies pending tracked migrations
with Supabase CLI **2.113.0** (`db push --yes`), then runs
`supabase/ci/verify-schema.sql` using the same pinned Postgres image as `db`.
A failure stops the chain and fails deployment; already-running backend
services are not rolled back. Re-running uses the CLI's migration history,
not a bespoke tracker or blind SQL replay.

Both jobs mount the checkout read-only at `/workspace` and connect to
`db:5432` as `postgres`, with `PGPASSWORD` supplied from the backend
Environment field, never embedded in their URL/command arguments. They
publish no ports and need no host SSH. The migration job uses
`node:22-alpine` and `npx`; outbound npm access is required on every fresh
one-off container. Lifecycle scripts stay disabled (also matching the root
`.npmrc`); CLI 2.113.0 supplies platform-specific optional binaries and was
checked with an isolated `--version` command on Alpine.

Dokploy runs from the checkout's `code/` directory. Explicitly setting
`--project-directory .` anchors all relative volume sources there, making
`../files/` correct despite the nested Compose file. The Environment field
still writes `code/deploy/supabase/.env`; the explicit `--env-file` reads
it, not a nonexistent root `.env`. Leave environment-file creation enabled.
Without this explicit project directory, normal Compose resolution from
`code/deploy/supabase/` would need `../../../files/` instead. Do not mix
the two layouts or rely on version-dependent automatic directory flags.

This recipe was checked against Dokploy
[v0.30.5's command builder](https://github.com/Dokploy/dokploy/blob/v0.30.5/packages/server/src/utils/builders/compose.ts)
(including its restricted `&& docker compose ...` chaining), Docker's
[volume merge rules](https://docs.docker.com/reference/compose-file/merge/#unique-resources),
and Supabase's [`db push` reference](https://supabase.com/docs/reference/cli/supabase-db-push).
Run `node --test scripts/dokploy-compose.test.mjs` locally with Docker Compose
installed to check all eleven bind replacements, named volumes, networks,
private API/database ports, and maintenance job configuration without loading secrets.
No live production deployment or database changes were tested.
Before starting, inspect the final merged configuration with the first
command's flags and `config --no-interpolate` instead of `up ...` (omit
both `&& ...` job commands); do not print a fully interpolated config
containing secrets.
Confirm every config source resolves under the project's `files/`, all
named data volumes remain present, and domain labels/networks are retained.
Update File Mount contents deliberately when upgrading the pinned backend,
and recreate/restart the affected services so they reload the new inputs.

Envoy renders `/etc/envoy/lds.yaml` inside the container, not into its
read-only source files. Studio's `snippets` and `functions-data` are named
volumes; `functions-data` is only Studio-managed file storage, not a running
Edge Runtime. Database and Storage data also remain in named volumes.

### 2. WACRM app project

- Source the repository root, using `docker-compose.yml` plus
  `docker-compose.dokploy.yml`. The override removes the published host
  port; Dokploy routes directly to service `app`, internal port **3000**.
  Compose must support `!reset` (v2.24.4+).
- Copy the generated root `.env.local` contents into the app project's
  **Environment** field and add `APP_ENV_FILE=.env`. Dokploy writes `.env`,
  while the root Compose defaults to `.env.local`; this setting bridges
  that difference for runtime secrets.
- Set `NEXT_PUBLIC_SUPABASE_URL=https://api.example.com`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the backend's matching `ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` to its matching `SERVICE_ROLE_KEY`, and
  `NEXT_PUBLIC_SITE_URL=https://crm.example.com`.
  Copy **only app configuration**, never the backend `JWT_SECRET`,
  `POSTGRES_PASSWORD`, or other backend-only credentials into this project.
- Replace `META_APP_SECRET` with the real Meta App secret (and configure
  your WhatsApp account/webhook). Unset `WHATSAPP_TEMPLATES_DRY_RUN` or set
  it to `false`. Preserve `ENCRYPTION_KEY` across every redeploy.
- Public URL/key values are forwarded as **build args** by root Compose;
  rebuild whenever `NEXT_PUBLIC_*` changes. Server-only secrets come from
  `env_file` at runtime. `.dockerignore` excludes env files, backend files,
  and scripts from the app image context.

If Dokploy cannot select both Compose files, use Advanced → Command. Start
from the full default command shown in the UI, retain its actual `-p`
project name and deployment options, and include both `-f` arguments. For
example (replace `YOUR_APP_PROJECT` with that existing project name):

```text
compose -p YOUR_APP_PROJECT -f docker-compose.yml -f docker-compose.dokploy.yml up -d --build --remove-orphans
```

Dokploy prefixes `docker`; a custom command **replaces**, not appends to,
the default. Verify the final preview has no published app port and still
has the domain labels/networks. See official [Compose configuration](https://docs.dokploy.com/docs/core/docker-compose)
and [domain routing](https://docs.dokploy.com/docs/core/docker-compose/domains).

Configure public DNS/TLS for both domains. The API name must be reachable
from the browser **and** the app container; do not leave a localhost URL or
assume two separate projects share a Docker service name. Test login,
confirmation/reset links, realtime updates, media access, and webhook
verification after deploying.

### Access controls and scheduling

- Keep Studio basic auth enabled with a strong unique password, plus a
  VPN or IP allowlist. On the public API hostname, restrict Studio and its
  management paths at the reverse proxy; do not globally block the Auth,
  REST, Storage, or Realtime paths used by the app. Review gateway routes
  before making an allowlist; do not expose management APIs unnecessarily.
- The production overlay publishes **no PostgreSQL or API host ports**.
  The HTTPS proxy reaches the gateway on its Docker network; migration
  jobs connect to `db:5432` internally. The base/local configuration's
  loopback ports 54322 and 8000 remain available only for local development.
- Nothing schedules jobs inside the app container. Set a strong
  `AUTOMATION_CRON_SECRET` and externally schedule
  `GET /api/automations/cron` and `GET /api/flows/cron` with header
  `x-cron-secret` carrying that value. Both return 503 without the secret.
- Self-hosting does not make media private: the app stores metadata and
  durable public Storage URLs, including WhatsApp attachments. Public
  bucket objects can be read by anyone with the URL; metadata RLS does not
  protect those bytes. Consider retention, consent, and backup access
  before storing sensitive conversations. Private buckets/signed URLs
  require application changes, not just a deployment toggle.

## Migrations and upgrades

`npm run supabase:migrate` uses Supabase CLI **2.113.0**, targets
`127.0.0.1:DB_HOST_PORT` (default 54322), and reads the database password
only from `deploy/supabase/.env`. With this CLI's explicit `--db-url`,
`SUPABASE_DB_PASSWORD` alone is ignored; the script also passes
`PGPASSWORD`, keeping the password out of the URL/command arguments.

For Dokploy production, the deployment chain above runs migration and
verification jobs inside the backend network, including on a fresh database.
No server checkout setup or SSH tunnel is needed for that path. For a
review-only dry-run, use Dokploy's command runner with the same project,
project-directory, env-file, and both Compose files, replacing the deployment
chain's `up ...` and subsequent jobs with:

```text
run --rm migrate npx --yes --package=supabase@2.113.0 supabase db push --db-url postgresql://postgres@db:5432/postgres?sslmode=disable --yes --dry-run
```

Compose `run` replaces (rather than appends to) the job command, so the full
command is required for a dry-run. Back up and review pending migrations
before deploying an upgrade; the deployment chain itself applies them
noninteractively.

The local npm helpers do not discover Dokploy services or target a cloud
project. They cannot connect directly to this production stack because
its database has no host port. Use the maintenance jobs for production;
do not expose PostgreSQL publicly just to run a migration. The npm schema
verification helper uses Docker Compose exec, so it only works on the
Docker server against the actual project (see the `c` helper below).

Back up before migrations or image updates. Review the dry-run, apply
migrations, then run `supabase/ci/verify-schema.sql` and smoke-test the app.
Never run `supabase db reset`, `docker compose down -v`, or volume pruning
against production. Do not regenerate credentials to fix an existing
volume: initialization credentials are not a password-rotation procedure.
Major Postgres upgrades need a separate tested upgrade plan.

Named volumes survive normal redeploys, but **changing the Compose project
name selects different volumes** and can look like data loss. Record the
actual Dokploy project name and volume names; keep them stable.

## Backups and restore rehearsal

Back up the database, file-backed Storage, backend secrets, and app secrets
as one recoverable set. Keep `ENCRYPTION_KEY` stable: losing/changing it
orphans encrypted WhatsApp/AI credentials. Also preserve backend signing,
vault/encryption keys and the `db-config` volume. Store encrypted off-host
copies with restricted access; database dumps contain personal data and
may contain credentials.

Example on the Docker server, from a checkout with the matching backend env.
Use **Bash**, not Windows PowerShell redirection (which can corrupt binary
archives or change SQL encoding). Replace `PROJECT` with the actual stable
Dokploy Compose project name; local default is `wacrm-supabase`:

```bash
umask 077
PROJECT=wacrm-supabase
c() { docker compose -p "$PROJECT" --env-file deploy/supabase/.env -f deploy/supabase/docker-compose.yml "$@"; }
mkdir -p backups
backup_dir="$(pwd)/backups"

# First stop app traffic, cron, webhooks, and other writers.
# Keep database and storage containers running for these commands.
c exec -T db pg_dump -U postgres -d postgres --clean --if-exists > "$backup_dir/postgres.sql"
c exec -T db pg_dumpall -U postgres --roles-only > "$backup_dir/roles.sql"
storage_container="$(c ps -q storage)"
docker run --rm --volumes-from "${storage_container}:ro" \
  -v "$backup_dir:/backup" alpine:3.22 \
  tar -czf /backup/storage.tar.gz -C /var/lib/storage .
db_container="$(c ps -q db)"
docker run --rm --volumes-from "${db_container}:ro" \
  -v "$backup_dir:/backup" alpine:3.22 \
  tar -czf /backup/db-config.tar.gz -C /etc/postgresql-custom .

# Verify the schema against this exact Compose project.
c exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/ci/verify-schema.sql
```

Check every command's exit status and archive contents before resuming
writers; a partial dump is not a backup. Securely copy both env files to
your encrypted backup store separately (do not print them). Capture
`snippets` and `functions-data` too if Studio has written files there.
Do not tar live Postgres `db-data` as a substitute for a consistent dump.

**Test restore in an isolated stack** with a different project name/ports,
the pinned images, no public routes, and no outbound jobs/webhooks. Restore
the saved keys and `db-config`, initialize the matching backend, then load
the SQL dump with `psql -v ON_ERROR_STOP=1` and restore the storage archive
into that stack's `storage-data` volume with Storage stopped. Review
`roles.sql` against the initialized Supabase roles before applying it;
existing roles must not be blindly recreated. Never run restore SQL or
extract archives into live production volumes. Verify schema, login,
media bytes/URLs, and decryption of saved app credentials before considering
the backup usable. Keep a record of the successful rehearsal and restore
procedure for your pinned version.
