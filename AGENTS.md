# AGENTS.md — @bermudi/pi-codex

Codex-native apply_patch, web search, and remote compaction for pi.

## Pi extension import contract (hard-won)

Pi loads extensions through a sandbox; this is the ONLY reliable mental model:

- **Bundled pi** (dist/bundle, the default download): jiti + `virtualModules`
  maps a fixed id list to bundled modules. Unmapped ids resolve natively.
- **Unbundled pi** (npm global install of dist/cli.js): jiti + `alias` table
  that **prefix-rewrites** `@earendil-works/pi-ai*` (and friends) onto
  `dist/compat.js`, corrupting any subpath import of those packages.
- **Pi's package installer runs npm with `--legacy-peer-deps`** —
  peerDependencies are NEVER on disk in `~/.pi/agent/npm`. Resolving a
  peer (e.g. `import.meta.resolve("@earendil-works/pi-ai")` alone) hard-fails
  in npm installs. This is how 0.1.5 broke in production.

Consequences:

1. Import sandbox-served ids statically (root, `/compat`, `/oauth`,
   `/providers/all`, typebox, pi-coding-agent, pi-tui, pi-agent-core).
   `generateDiffString` and `CompactionSummaryMessageComponent` are public
   root exports of pi-coding-agent — never reach into pi's dist tree by URL.
2. pi-ai's `./api/*` subpath (the Responses converters) is public API but NOT
   sandbox-served, so `@earendil-works/pi-ai` is declared a regular
   **dependency** and the subpath is resolved via
   `import.meta.resolve` of the package ROOT + relative URL composition
   (works in all three runtimes; see src/remote-compaction.ts for why).
   pi-ai's `./api/*` exports have no `"require"` condition —
   `require.resolve` cannot see it.
3. `test/import-contract.test.ts` enforces all of this statically. It would
   have caught the 0.1.5 regression. Keep it passing; extend SANDBOXED_IDS
   when pi's loader changes.

## Verification

Before shipping a resolution change, verify all three runtimes:

- `npm test` (plain node + the RPC load test = alias mode via devDep pi)
- Managed-root simulation: install the packed tarball into a fake
  `~/.pi/agent/npm` with `npm install --omit=dev --legacy-peer-deps`, write
  `settings.json` with `"npm:@bermudi/pi-codex"`, run the REAL bundled pi:
  `HOME=<fake> pi --mode rpc --no-session --no-skills --no-context-files
  --offline <<< '{"id":"state","type":"get_state"}'` → expect success.

## Conventions

- Node ≥ 22.19, ESM, TypeScript strict (`npm run check`).
- Tests: `node --test --experimental-strip-types` (npm test).
- `pi install <tarball-path>` is a LOCAL path install (loads from the path,
  no managed npm root) — not a fidelity test for npm installs.
- Long-term: if pi ever serves `./api/*` through the sandbox (or pi-ai adds
  a `"require"` condition), replace the resolve dance in
  src/remote-compaction.ts with a static subpath import and drop the
  dependency entry back to peer-only.
