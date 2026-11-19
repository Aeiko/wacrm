# Staff inspection: image-based Dokploy staging

This branch supplies the [Compose manifest](../../docker-compose.staff-inspection.dokploy.yml) for a **new, isolated staging project**. It does not contain a reproducible source release of the tested CRM or inspection host. Do not use the root Dockerfile on this branch to recreate those images. The inspection Dockerfile here describes how a separately reviewed `host.cjs` bundle is packaged; Compose does not invoke it.

Before a separately approved deployment:

1. Choose the staging target, private HTTPS origin, named operator, risk owner and stop time. Keep auto-deploy and automatic domains off. Do not select the existing KC project or join its network.
2. Supply both reviewed images built for the intended staging settings, preload them on the target and verify their immutable IDs/digests. `pull_policy: never` means pushing this branch neither publishes nor installs images. The full CRM's public Auth URL and anon key must match its build-time values.
3. Provide staging-only Auth, database and a restricted gateway at `inspection-gateway:8000`. The two-service manifest does not create them, migrate a database or set up a public proxy. Supply staging credentials privately, not in Git. Do not give the inspection service production or operator privileges.
4. Keep the staff gateway private (named staff with MFA). Login and inspection use one origin; route inspection only to the operator's intended process. An ordinary start has no invitation. Use only the separately reviewed, one-shot operator pipe, never a Compose variable or a pasted invitation. A lost handoff or restart means stop; do not reissue.

**Database files (staff staging only):** This candidate adds the forward migrations SQL060–084 under `supabase/migrations/` and updates `supabase/ci/verify-schema.sql`. Git push and `docker compose config --quiet` do not apply them. On a separately approved, isolated staging database, the order is: apply the repository migrations through 084, verify the schema, then install [`inspection-status.sql`](inspection-status.sql) once as `postgres`. The inspection function is separate from the migration sequence so it is not automatically installed on KC. Do not give its caller the postgres credential or expose a general service-role endpoint. Installing the files does not issue an invitation or enable onboarding or import.

**Review without deploying:** `node --test scripts/staff-inspection-compose.test.mjs` renders the manifest with fixture values and checks its restrictions. No live client number, Meta action, history request or production change is part of this staging scope.
