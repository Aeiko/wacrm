# Dependency security review

Reviewed 2026-11-13. This covers the root WACRM application, not a guarantee
that the application or its container images are vulnerability-free.

## Applied updates

- Next.js and `eslint-config-next`: `16.3.8` → `16.4.6`.
  [Next.js 16.4.1](https://github.com/vercel/next.js/releases/tag/v16.4.1)
  contains the two critical fixes and Server Actions DoS fix reported by
  the audit; 16.4.6 includes subsequent stable fixes.
- shadcn: `4.21.4` → `4.22.2`, retaining its CSS export used by
  `src/app/globals.css`. This updates its Zod integration without adopting
  the separate MCP SDK v2 migration in shadcn 4.23.
- Updated compatible HTTP/parser/schema dependencies through npm and
  raised the existing Hono, Undici, fast-uri and ip-address override
  minimums to patched versions. No forced major-version overrides.
- `.npmrc` disables third-party install lifecycle scripts. Docker copies
  that policy before `npm ci`; explicitly requested `npm run` commands
  still run. Clean installation, tests and builds must remain verified
  when changing dependencies.
- CI runs `npm audit --audit-level=high` across production **and**
  development dependencies. Low/moderate findings are not hidden or
  treated as absent.

## Residual root findings

The application audit has **no high or critical findings**. The remaining
package-level findings trace to these two advisories:

| Dependency | Reason not force-fixed | Exposure and follow-up |
| --- | --- | --- |
| `deepmerge@4.3.1` | No patched release was available. Downgrading merely to escape an advisory range is not a fix. | Transitive shadcn/registry tooling. The app imports shadcn CSS, not its JavaScript API; deepmerge was absent from the generated standalone server. Avoid untrusted registry configuration; recheck for a real upstream fix. |
| `minimatch@10.x` | The published fix is 11.0.1, outside ts-morph/typescript-eslint's declared ranges and involving matching-engine/API changes. | Build/lint tooling. The advisory requires `optimizationLevel >= 2`; inspected callers do not set that option. Minimatch was absent from the generated standalone server. Recheck upstream compatible releases rather than forcing v11 globally. |

These are scoped deferrals, not claims of universal non-exploitability.
Review them again by **2026-12-13**, earlier if the owning packages ship a
compatible fix or tooling begins accepting untrusted configuration.

Sources:
[deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4),
[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[shadcn 4.22.2](https://github.com/shadcn-ui/ui/releases/tag/shadcn%404.22.2).

## Optional MCP server is a separate package

`mcp-server/` has its own manifest and lockfile, is excluded from the app
Docker context, and is not deployed by the app/Supabase Compose setup.
Its separate audit still reported **2 high and 5 moderate package
findings**, including Zod 3, which has no patched 3.x version for the
reported advisory. Updating that server to Zod 4 requires a separate
schema/tool compatibility check. Its transport is stdio; installed HTTP
packages alone do not establish a remotely reachable HTTP vulnerability.
Do not treat the root application's audit result as clearing this package.

## Recheck before deploying

```bash
npm ci
npm audit --audit-level=high
npm test
npm run test:selfhost
npm run lint
npm run typecheck
npm run build
```

Use the declared npm version (`10.9.9`) when updating the lockfile. Never
use `npm audit fix --force` without reviewing the resulting migrations.
Dependency audits do not replace container scanning, HTTPS configuration,
access-control checks, or a successful backup/restore rehearsal.
