import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const packageRoot = join(import.meta.dirname, "..");

/**
 * Install-script guard for the published dependency tree.
 *
 * `@earendil-works/pi-ai` is a runtime dependency (see AGENTS.md), so its
 * whole provider tree lands in every consumer's `~/.pi/agent/npm`. npm's
 * allowlist blocks unapproved install scripts there by default — good — but
 * a transitive dep can start shipping a script at any minor bump, and a
 * blocked script that actually matters breaks consumers' installs loudly
 * while a malicious one is a supply-chain attempt.
 *
 * This test walks the PROD-ONLY subgraph of package-lock.json and fails when
 * a package with `hasInstallScript: true` appears that is not explicitly
 * allowlisted below. Adding an entry means a human reviewed what the script
 * does (read it in the installed tarball — do not trust the name).
 */

const ALLOWED_SCRIPT_PACKAGES = new Map([
  // Empty since pi-ai (the only prod dep with scripted transitive deps:
  // @google/genai, protobufjs) moved to a peer — peers are outside the prod
  // tree. Re-add entries here when a new dependency ships install scripts.
]);

type LockPackage = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  hasInstallScript?: boolean;
  version?: string;
};

const lock = JSON.parse(
  readFileSync(join(packageRoot, "package-lock.json"), "utf8"),
) as { packages: Record<string, LockPackage> };
const packages = lock.packages;

/** Resolve a dependency name from the package at lockfile path `fromPath`. */
function resolve(fromPath: string, dep: string): string | null {
  let prefix = fromPath;
  for (;;) {
    const candidate = `${prefix ? `${prefix}/` : ""}node_modules/${dep}`;
    if (packages[candidate]) return candidate;
    if (!prefix) return null;
    const i = prefix.lastIndexOf("node_modules/");
    prefix = i <= 0 ? "" : prefix.slice(0, i - 1);
  }
}

function packageNameOf(entryPath: string): string {
  return entryPath.slice(entryPath.lastIndexOf("node_modules/") + "node_modules/".length);
}

test("prod dependency tree has no unapproved install scripts", () => {
  assert.ok(packages, "package-lock.json v3 with packages map expected");

  // BFS over prod deps only (devDependencies never reach consumers).
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const dep of Object.keys(packages[""]?.dependencies ?? {})) {
    const resolved = resolve("", dep);
    if (resolved) queue.push(resolved);
  }

  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const entry = packages[path]!;
    for (const dep of [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
    ]) {
      const resolved = resolve(path, dep);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  const scriptful = [...seen]
    .filter((p) => packages[p]!.hasInstallScript)
    .map((p) => `${packageNameOf(p)}@${packages[p]!.version}`)
    .sort();

  function nameOf(scriptfulEntry: string): string {
  // "@google/genai@1.52.0" → "@google/genai" (rfind '@', scoped names)
  return scriptfulEntry.slice(0, scriptfulEntry.lastIndexOf("@"));
}

const unapproved = scriptful.filter((s) => !ALLOWED_SCRIPT_PACKAGES.has(nameOf(s)));
  assert.deepStrictEqual(
    unapproved,
    [],
    [
      "New package(s) with install scripts entered the prod dependency tree:",
      ...unapproved.map((s) => `  ${s}`),
      "Review what their scripts actually do (read the installed files), then either",
      "add them to ALLOWED_SCRIPT_PACKAGES in this test with a justification, or",
      "pin/upgrade to a version without scripts.",
    ].join("\n"),
  );

  // Keep the allowlist honest: entries that no longer apply are stale.
  const stale = [...ALLOWED_SCRIPT_PACKAGES.keys()].filter(
    (name) => !scriptful.some((s) => nameOf(s) === name),
  );
  assert.deepStrictEqual(
    stale,
    [],
    `Stale allowlist entries (no longer in prod tree, remove them): ${stale.join(", ")}`,
  );

  console.log(
    `prod tree: ${seen.size} packages, install scripts: ${scriptful.length ? scriptful.join(", ") : "none"}`,
  );
});
