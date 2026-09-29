// Regenerates src/vendor/openai-responses-shared.mjs from the locally
// installed @earendil-works/pi-ai. Run `npm run vendor` whenever the pi-ai
// peer range moves; test/vendor-parity.test.ts fails when the vendored copy
// drifts from the installed pi-ai.
//
// The bundle is fully self-contained (pi-ai's relative imports AND its
// runtime deps like partial-json are inlined; there are no bare imports left,
// so nothing has to resolve at runtime). The banner records the source
// version so drift is visible in review.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// pi-ai's exports map exposes neither "./package.json" nor a "require"
// condition, so resolution must go through import URLs, not require().
const entryUrl = import.meta.resolve(
  "@earendil-works/pi-ai/api/openai-responses-shared",
);
const entry = fileURLToPath(entryUrl);
const piAiPackageJson = join(
  fileURLToPath(new URL("../../package.json", entryUrl)),
);
const piAi = JSON.parse(readFileSync(piAiPackageJson, "utf8"));

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
      `// Vendored from @earendil-works/pi-ai@${piAi.version} (dist/api/openai-responses-shared.js + dependency closure).`,
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
