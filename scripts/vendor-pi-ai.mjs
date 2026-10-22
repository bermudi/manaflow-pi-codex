// Regenerates src/vendor/openai-responses-shared.mjs from the pi-ai that
// the installed @earendil-works/pi-coding-agent depends on — the version
// pi's extension sandbox serves at runtime (NOT the root-hoisted pi-ai,
// which other devDependencies may move to a newer version). Run `npm run
// vendor` whenever the pi-coding-agent devDependency moves; the vendored
// banner records the source version, and test/vendor-parity.test.ts fails
// when the vendored copy drifts from the pi-ai that pi actually bundles.
//
// The bundle is fully self-contained (pi-ai's relative imports AND its
// runtime deps like partial-json are inlined; there are no bare imports left,
// so nothing has to resolve at runtime). The banner records the source
// version so drift is visible in review.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve the pi-ai that the installed @earendil-works/pi-coding-agent
// depends on — the version pi's extension sandbox serves at runtime. A
// resolution from THIS package would pick the root-hoisted pi-ai, which other
// devDependencies can move to a newer version. pi-coding-agent pins its
// pi-ai, so the copy nested under it is authoritative; npm only hoists that
// copy to the root when it is the same instance anyway, making the root the
// correct fallback. pi-ai's exports map exposes neither "./package.json" nor
// a "require" condition, so resolution goes through import URLs and package
// boundaries, not require().
function piAiEntryPaths() {
  const piCodingAgentMain = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  for (
    let dir = dirname(piCodingAgentMain);
    dir !== dirname(dir);
    dir = dirname(dir)
  ) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    if (JSON.parse(readFileSync(manifest, "utf8")).name !== "@earendil-works/pi-coding-agent") {
      continue;
    }
    const nested = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "package.json",
    );
    if (existsSync(nested)) {
      return {
        entry: join(
          dir,
          "node_modules",
          "@earendil-works",
          "pi-ai",
          "dist",
          "api",
          "openai-responses-shared.js",
        ),
        manifest: nested,
      };
    }
  }
  const entryUrl = import.meta.resolve(
    "@earendil-works/pi-ai/api/openai-responses-shared",
  );
  return {
    entry: fileURLToPath(entryUrl),
    manifest: fileURLToPath(new URL("../../package.json", entryUrl)),
  };
}

const { entry, manifest } = piAiEntryPaths();
const piAi = JSON.parse(readFileSync(manifest, "utf8"));

// No `external`: the converter closure is pure data-in/data-out (no shared
// symbols or registries with the sandboxed pi-ai instance), so inlining its
// whole dependency closure — including partial-json — is safe and keeps the
// extension's runtime dependency-free.
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  legalComments: "inline",
  outfile: join(packageRoot, "src/vendor/openai-responses-shared.mjs"),
  banner: {
    js: [
      "// GENERATED FILE — do not edit by hand.",
      `// Vendored from @earendil-works/pi-ai@${piAi.version} (dist/api/openai-responses-shared.js + dependency closure),`,
      "// the version bundled by @earendil-works/pi-coding-agent.",
      "// Regenerate with: npm run vendor",
    ].join("\n"),
  },
});

const out = readFileSync(
  join(packageRoot, "src/vendor/openai-responses-shared.mjs"),
  "utf8",
);
const bareImports = [...out.matchAll(/(?:^|[\s;])(?:import|export)[^;]*?from\s*["']([^."'~/][^"']*)["']/g)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith("node:"));
if (bareImports.length > 0) {
  console.error(
    `vendor output has bare imports — the bundle is not self-contained: ${bareImports.join(", ")}`,
  );
  process.exit(1);
}
console.log(`vendored @earendil-works/pi-ai@${piAi.version} → src/vendor/openai-responses-shared.mjs`);
