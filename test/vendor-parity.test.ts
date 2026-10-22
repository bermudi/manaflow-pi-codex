import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Guards the vendored pi-ai Responses converter against drift.
 *
 * src/vendor/openai-responses-shared.mjs is a generated snapshot of
 * @earendil-works/pi-ai's `./api/openai-responses-shared` module (see
 * scripts/vendor-pi-ai.mjs). The reference is the pi-ai that the installed
 * @earendil-works/pi-coding-agent depends on — the version pi's extension
 * sandbox serves at runtime — NOT the root-hoisted pi-ai, which other
 * devDependencies may resolve to a newer version. When the pi-coding-agent
 * devDependency moves and the vendored file is not regenerated, the banner
 * version check and the conversion fixtures below fail.
 */

type Converter = (...args: unknown[]) => unknown;

/**
 * Mirrors the resolution in scripts/vendor-pi-ai.mjs: find the pi-ai nested
 * under the installed pi-coding-agent (its exact pin), falling back to the
 * root copy — which npm only makes authoritative when it is the same
 * instance. pi-ai's exports map exposes neither "./package.json" nor a
 * "require" condition, so this walks package boundaries and imports by file
 * URL instead of resolving the subpath from this package.
 */
function resolveBundledPiAi(): { module: string; version: string } {
  const piMain = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  for (let dir = dirname(piMain); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    if ((parsed as { name?: string }).name !== "@earendil-works/pi-coding-agent") {
      continue;
    }
    const nested = join(dir, "node_modules", "@earendil-works", "pi-ai");
    if (existsSync(join(nested, "package.json"))) {
      return {
        module: join(nested, "dist", "api", "openai-responses-shared.js"),
        version: (JSON.parse(readFileSync(join(nested, "package.json"), "utf8")) as {
          version: string;
        }).version,
      };
    }
  }
  const rootEntry = import.meta.resolve(
    "@earendil-works/pi-ai/api/openai-responses-shared",
  );
  return {
    module: fileURLToPath(rootEntry),
    version: (
      JSON.parse(
        readFileSync(fileURLToPath(new URL("../../package.json", rootEntry)), "utf8"),
      ) as { version: string }
    ).version,
  };
}

const bundled = resolveBundledPiAi();

const vendored = await import("../src/vendor/openai-responses-shared.mjs");
// The pi-ai that pi actually bundles at runtime, not the root-hoisted copy.
const installed = await import(pathToFileURL(bundled.module).href);

const model = {
  provider: "openai-codex",
  id: "gpt-5.3-codex",
  api: "openai-codex-responses",
  reasoning: true,
  input: ["text", "image"],
};

const fixtureTools = [
  {
    name: "apply_patch",
    description: "Apply a patch",
    parameters: { type: "object", properties: { patch: { type: "string" } } },
  },
];

function fixtureMessages() {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Summarize the transcript." }],
    },
    {
      // Replayed from a different model: the converter must drop the
      // fc_/ctc_ item ids (cross-model ids are not valid server-side) and
      // emit a custom_tool_call for the grammar-mapped name.
      role: "assistant",
      model: "gpt-5.2-codex",
      api: "openai-codex-responses",
      provider: "openai-codex",
      content: [
        { type: "text", text: "Working on it." },
        {
          type: "toolCall",
          id: "call_1|fc_1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "call_2|fc_2",
          name: "apply_patch",
          arguments: { patch: "x" },
        },
      ],
    },
    {
      // Whitespace-only tool output: pi-ai 1.3.x passes the text through;
      // a newer pi-ai that trims or replaces it must be re-vendored.
      role: "toolResult",
      toolCallId: "call_1|fc_1",
      toolName: "bash",
      content: [{ type: "text", text: "   \n  " }],
    },
    {
      // Empty tool output: the "(no tool output)" fallback branch.
      role: "toolResult",
      toolCallId: "call_2|fc_2",
      toolName: "apply_patch",
      content: [],
    },
  ];
}

function fixtureConstrainedTools() {
  return [
    ...structuredClone(fixtureTools),
    {
      name: "grammar_tool",
      description: "Grammar-constrained tool",
      parameters: {
        type: "object",
        properties: { payload: { type: "string" } },
        required: ["payload"],
      },
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: "start: WORD" },
      },
    },
    {
      name: "strict_json_tool",
      description: "Strict JSON schema tool",
      parameters: { type: "object", properties: {} },
      constrainedSampling: { type: "json_schema", strict: "require" },
    },
  ];
}

test("vendored converter is regenerated from the pi-ai that pi actually bundles", () => {
  const vendoredSource = readFileSync(
    new URL("../src/vendor/openai-responses-shared.mjs", import.meta.url),
    "utf8",
  );
  const banner = vendoredSource.match(
    /^\/\/ Vendored from @earendil-works\/pi-ai@(\d+\.\d+\.\d+)/m,
  );
  assert.ok(banner, "vendored file is missing its version banner");
  assert.equal(
    banner[1],
    bundled.version,
    "vendored pi-ai version does not match the pi-ai bundled by @earendil-works/pi-coding-agent — run npm run vendor",
  );
});

test("vendored converter matches the bundled pi-ai (messages)", () => {
  const context = { messages: fixtureMessages() };
  const toolCallProviders = new Set(["openai", "openai-codex"]);
  const options = {
    includeSystemPrompt: false,
    grammarToolInputProperties: new Map([["apply_patch", "patch"]]),
  };
  const fromVendor = (vendored.convertResponsesMessages as Converter)(
    model,
    context,
    toolCallProviders,
    options,
  );
  const fromInstalled = (installed.convertResponsesMessages as Converter)(
    model,
    { messages: structuredClone(fixtureMessages()) },
    new Set(toolCallProviders),
    options,
  );
  // The fixtures must exercise the drift-sensitive branches: dropped
  // fc_/ctc_ ids on cross-model replay, whitespace-only and empty tool
  // outputs.
  const json = JSON.stringify(fromVendor);
  assert.match(json, /custom_tool_call/);
  assert.match(json, /no tool output/);
  assert.match(json, /   \\n  /);
  assert.doesNotMatch(json, /fc_1|fc_2/);
  assert.deepStrictEqual(fromVendor, fromInstalled);
});

test("vendored converter matches the bundled pi-ai (incremental tool declarations)", () => {
  const lateTool = {
    name: "late_tool",
    description: "Added mid-conversation",
    parameters: { type: "object", properties: {} },
  };
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "system", content: "New tool available.", toolsAdded: [lateTool] },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ];
  const options = {
    includeSystemPrompt: false,
    supportsMidConvoSystemMessages: true,
    supportsAdditionalTools: true,
    toolOptions: { strict: null, supportsStrictMode: true },
  };
  const fromVendor = (vendored.convertResponsesMessages as Converter)(
    model,
    { messages },
    new Set(["openai-codex"]),
    options,
  );
  const fromInstalled = (installed.convertResponsesMessages as Converter)(
    model,
    { messages: structuredClone(messages) },
    new Set(["openai-codex"]),
    options,
  );
  const json = JSON.stringify(fromVendor);
  assert.match(json, /additional_tools/);
  assert.match(json, /late_tool/);
  assert.deepStrictEqual(fromVendor, fromInstalled);
});

test("vendored converter matches the bundled pi-ai (tools)", () => {
  const options = {
    strict: null,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
  };
  const fromVendor = (vendored.convertResponsesTools as Converter)(
    structuredClone(fixtureConstrainedTools()),
    options,
  );
  const fromInstalled = (installed.convertResponsesTools as Converter)(
    structuredClone(fixtureConstrainedTools()),
    options,
  );
  const json = JSON.stringify(fromVendor);
  assert.match(json, /"type":"custom"/);
  assert.match(json, /"type":"grammar"/);
  assert.deepStrictEqual(fromVendor, fromInstalled);
});
