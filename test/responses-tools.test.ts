import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCodex from "../extensions/pi-codex.ts";
import { installTopLevelResponsesTools } from "../src/responses-tools.ts";

// Envelope shapes observed using before_provider_request on installed Pi 1.4.0;
// descriptions, parameters, and the grammar below are intentionally minimal.
const read = {
  type: "function",
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  strict: false,
};
const patch = {
  type: "custom",
  name: "apply_patch",
  description: "Apply a patch",
  format: { type: "grammar", syntax: "lark", definition: 'start: "patch"' },
};
const addition = (tools: unknown[]) => ({
  type: "additional_tools",
  role: "developer",
  tools,
});

test("hoists declarations without changing grammar, strictness, or prompts", () => {
  const prompt = {
    role: "developer",
    content: "Available tools: read, bash, edit, write.",
  };
  const user = { role: "user", content: "list your tools" };
  const payload = { input: [addition([read, patch]), prompt, user] };

  assert.equal(installTopLevelResponsesTools(payload, ["read", "apply_patch"]), 2);
  assert.deepEqual(payload, { tools: [read, patch], input: [prompt, user] });
  assert.equal((payload as { tools?: unknown[] }).tools?.[1], patch);
});

test("uses the latest schema and excludes removed or hidden declarations", () => {
  const revised = { ...read, description: "Prepared tool description" };
  const payload = {
    input: [
      addition([read, patch, { ...read, name: "edit" }]),
      { role: "developer", content: "The following tools are no longer available: edit" },
      addition([revised]),
    ],
  };
  installTopLevelResponsesTools(payload, ["read", "apply_patch", "codemode"]);
  assert.deepEqual((payload as { tools?: unknown[] }).tools, [revised, patch]);
  // A tool absent from the request is not resurrected from the active registry.
  assert.equal(JSON.stringify(payload).includes('"name":"codemode"'), false);
});

test("retains existing server tools and deduplicates named tools", () => {
  const server = { type: "web_search" };
  const payload = { tools: [server, read], input: [addition([read, patch])] };
  installTopLevelResponsesTools(payload, ["read", "apply_patch"]);
  assert.deepEqual(payload.tools, [server, read, patch]);
});

test("does not change requests without incremental declarations", () => {
  for (const payload of [
    null,
    {},
    { input: "previous response" },
    { input: [], tools: [patch] },
  ]) {
    const before = structuredClone(payload);
    assert.equal(installTopLevelResponsesTools(payload, ["apply_patch"]), undefined);
    assert.deepEqual(payload, before);
  }
});

test("reports malformed declarations before mutating the request", () => {
  for (const payload of [
    { input: [{ type: "additional_tools" }] },
    { input: [addition([null])] },
    { input: [addition([patch])], tools: "invalid" },
  ]) {
    const before = structuredClone(payload);
    assert.throws(() => installTopLevelResponsesTools(payload, ["apply_patch"]), /Responses/);
    assert.deepEqual(payload, before);
  }
});

test("empty batches clear stale named tools without dropping messages", () => {
  const user = { role: "user", content: "continue" };
  const payload = { input: [addition([read, patch]), addition([]), user] };
  installTopLevelResponsesTools(payload, []);
  assert.deepEqual(payload, { tools: [], input: [user] });
});

test("request hook fixes plain OpenAI even without server compaction; leaves Codex alone", async () => {
  type Handler = (event: never, ctx: never) => unknown;
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    getActiveTools: () => ["read", "apply_patch"],
  } as unknown as ExtensionAPI;
  piCodex(pi);
  const hook = handlers.get("before_provider_request");
  assert.ok(hook);
  for (const provider of ["openai", "openai-codex", "other"]) {
    const payload = { input: [addition([read, patch])] };
    const before = structuredClone(payload);
    await hook(
      { payload } as never,
      {
        model: {
          provider,
          api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
          id: "gpt-4.1",
        },
        sessionManager: { getBranch: () => [] },
      } as never,
    );
    if (provider === "openai") {
      assert.deepEqual(payload, { tools: [read, patch], input: [] });
    } else {
      assert.deepEqual(payload, before);
    }
  }
});
