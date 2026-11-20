# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Installed from the globally installed `install-anti-slop` skill's `assets/anti-slop` directory using its `scripts/install.mjs`.
- Exact upstream revision: unknown; the installed skill bundle does not provide a verified source commit.
- Vendored path: `tools/oxlint/anti-slop/` (generic and Effect source included).
- Local source deviations: none; this provenance file was added locally.
- Configuration: all 18 generic rules and native `oxc/no-accumulating-spread` enabled at error severity in `.oxlintrc.json`. Effect rules are not enabled because this project has no direct Effect dependency.
- Oxlint and `@oxlint/plugins` pinned together at 1.94.0.

Preserve the nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` with this code. Review and merge future upstream changes rather than replacing local customizations blindly.
