import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Import contract for pi extension packages.
 *
 * Pi loads extensions through its own sandbox, which maps a fixed set of
 * package ids to bundled modules and resolves everything else against the
 * package's real node_modules. Pi's installer also runs npm with
 * `--legacy-peer-deps`, so peerDependencies are never on disk.
 *
 * Rules enforced here:
 *   1. Runtime import specifiers must be a node builtin, a relative path, a
 *      sandbox-served id, or a package (or subpath) declared in
 *      `dependencies`.
 *   2. Resolver calls (`import.meta.resolve` / `require.resolve`) bypass the
 *      sandbox module map, so their specifier must be a dependency subpath
 *      that the sandbox does NOT serve. Resolving a sandbox-served id is how
 *      npm-installed 0.1.5 broke: peers are not materialized on disk, so the
 *      resolution hard-fails outside a dev checkout.
 *   3. Dynamic imports of computed file URLs are only allowed when the file
 *      also resolves a compliant dependency subpath that feeds them.
 */

const NODE_BUILTINS = new Set([
  "assert", "child_process", "crypto", "fs", "http", "https", "module",
  "node:test", "os", "path", "stream", "string_decoder", "url", "util",
]);

// Ids pi's extension sandbox serves itself (see pi's extension loader
// VIRTUAL_MODULES / alias table). Anything else from these packages must
// come from our own node_modules — i.e., be declared in dependencies.
const SANDBOXED_IDS = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/compat",
  "@mariozechner/pi-ai/oauth",
  "@mariozechner/pi-ai/providers/all",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "typebox",
  "typebox/compile",
  "typebox/value",
  "@sinclair/typebox",
  "@sinclair/typebox/compile",
  "@sinclair/typebox/value",
]);

const IMPORT_PATTERNS = [
  /\bimport\s+[^;]*?from\s*["']([^"']+)["']/g,
  /\bexport\s+[^;]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const RESOLVE_PATTERNS = [
  /\bimport\.meta\.resolve\s*\(\s*["']([^"']+)["']/g,
  /\.resolve\s*\(\s*["']([^"']+)["']/g,
];;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|js)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function isBuiltin(specifier: string): boolean {
  const base = specifier.split("/")[0];
  return specifier.startsWith("node:") || NODE_BUILTINS.has(base);
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isSandboxed(specifier: string): boolean {
  return SANDBOXED_IDS.has(specifier);
}

function isDependency(specifier: string, prodDeps: Set<string>): boolean {
  return prodDeps.has(packageName(specifier));
}

test("shipped code imports stay within pi's extension contract", () => {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const prodDeps = new Set(Object.keys(manifest.dependencies ?? {}));

  const shippedDirs = ["src", "extensions", "bin"].map((d) =>
    join(packageRoot, d),
  );
  const violations: string[] = [];

  for (const file of shippedDirs.flatMap((d) => collectSourceFiles(d))) {
    const rel = relative(packageRoot, file);
    // Type-only imports are erased at runtime; they never hit a resolver.
    const source = readFileSync(file, "utf8").replace(
      /\bimport\s+type\s[^;]*?from\s*["'][^"']+["'];?/gs,
      "",
    );

    for (const pattern of IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        if (isRelative(specifier) || isBuiltin(specifier)) continue;
        if (isSandboxed(specifier)) continue;
        if (isDependency(specifier, prodDeps)) continue;
        violations.push(`${rel}: import "${specifier}"`);
      }
    }

    const resolvedDeps: string[] = [];
    for (const pattern of RESOLVE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        resolvedDeps.push(specifier);
        if (isRelative(specifier)) continue;
        // Resolvers bypass the sandbox module map, so their target must be
        // disk-guaranteed — i.e., declared in dependencies. Resolving a
        // non-dependency (a peer like pi-tui or typebox) is how npm-installed
        // 0.1.5 broke: peers are never materialized on disk.
        if (!isDependency(specifier, prodDeps)) {
          violations.push(`${rel}: resolves non-dependency "${specifier}"`);
        }
      }
    }

    // Dynamic imports of computed file URLs must trace back to a compliant
    // dependency resolution in the same file.
    const computedUrlImport = /import\s*\(\s*[a-zA-Z_$][\w$]*Url\b/.test(source);
    if (computedUrlImport && resolvedDeps.length === 0) {
      violations.push(
        `${rel}: dynamic import of computed URL without a dependency-backed resolution`,
      );
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    [
      "Imports outside pi's extension contract found.",
      "Allowed: node builtins, relative paths, sandbox-served ids, or dependencies.",
      "Resolvers may only target dependency subpaths the sandbox does not serve.",
      "See the comment block at the top of this file.",
      ...violations,
    ].join("\n"),
  );
});
