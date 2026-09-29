import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Guards the vendored pi-ai Responses converter against drift.
 *
 * src/vendor/openai-responses-shared.mjs is a generated snapshot of
 * @earendil-works/pi-ai's `./api/openai-responses-shared` module (see
 * scripts/vendor-pi-ai.mjs). When the pi-ai peer range moves and the vendor
 * file is not regenerated, this test fails by comparing real conversions
 * against the locally installed pi-ai (dev checkouts auto-install peers).
 */

type Converter = (...args: unknown[]) => unknown;

const vendored = await import("../src/vendor/openai-responses-shared.mjs");
// Native resolution: devDependency install of the peer, NOT the sandbox.
const installed = await import("@earendil-works/pi-ai/api/openai-responses-shared");

const model = {
  provider: "openai-codex",
  id: "gpt-5.3-codex",
  reasoning: true,
  input: ["text", "image"],
};

function fixtureMessages() {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Summarize the transcript." }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Working on it." }],
      api: "openai-codex-responses",
      provider: "openai-codex",
    },
    {
      role: "toolResult",
      toolCallId: "ctc_abc123",
      toolName: "apply_patch",
      content: [{ type: "text", text: "Done." }],
      api: "openai-codex-responses",
      provider: "openai-codex",
    },
  ];
}

const fixtureTools = [
  {
    name: "apply_patch",
    description: "Apply a patch",
    parameters: { type: "object", properties: { patch: { type: "string" } } },
  },
];

test("vendored converter matches installed pi-ai (messages)", () => {
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
    context,
    new Set(toolCallProviders),
    options,
  );
  assert.deepStrictEqual(fromVendor, fromInstalled);
});

test("vendored converter matches installed pi-ai (tools)", () => {
  const options = {
    strict: null,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
  };
  const fromVendor = (vendored.convertResponsesTools as Converter)(
    structuredClone(fixtureTools),
    options,
  );
  const fromInstalled = (installed.convertResponsesTools as Converter)(
    structuredClone(fixtureTools),
    options,
  );
  assert.deepStrictEqual(fromVendor, fromInstalled);
});
