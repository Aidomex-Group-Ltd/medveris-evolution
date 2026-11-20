# Runtime dependency audit exceptions — 2026-11-18

The deployment workflows and the production gate use `npm run audit:runtime`
(`scripts/audit-check.mjs`). It runs `npm audit --omit=dev --json`, prints **every**
finding with its severity, range and suggested fix, and exits non-zero for any
`high` or `critical` finding outside the narrow exception list below. Nothing is
suppressed from the output; `--force` and `--audit-level` downgrades are not used.

## Resolved: Vite

- Advisory range `<=6.4.3` (middleware serving files with the same name as the
  public directory; `server.fs` not applied to HTML files; `server.fs.deny` bypass
  via backslash on Windows).
- Resolution: pinned to the compatible patched release `6.4.6` in the root and
  `apps/web` manifests (`6.x`, not a major upgrade).

## Documented exception: picomatch chain

- Advisory: `picomatch` ReDoS through single-branch repeated extglobs, range
  `<=4.0.7`. `4.0.7` is the latest published version; no patched release exists.
- Reachable versions in this tree: `vitest` → `tinyglobby` → `fdir` → `picomatch`.
- Suggested fix from npm is `vitest@3.1.4`, a **major downgrade** from the
  repository's Vitest 4 line. It would invalidate the current Vitest 4 config and
  test suite, so it is deliberately not applied.
- Exception scope: the `picomatch` advisory `GHSA-fc5q-39xc-vjpf` itself, plus
  `fdir`, `tinyglobby`, `vitest` and `vite` **only when their `via` list contains
  no direct advisory and consists solely of packages in this chain**. With Vite
  6.4.6, `npm audit` still lists `vite` as high because it depends on
  `fdir`/`picomatch`/`tinyglobby`; that is a transitive effect, not a direct Vite
  advisory. Any direct advisory on Vite (or any other package), or a new
  advisory on a chain package, is still blocking.
- This exception is visible in every audit run: the script prints each finding
  as `[documented exception]` and reports the blocking count. Review and remove
  this section when a patched `picomatch` or compatible Vitest fix is published.
