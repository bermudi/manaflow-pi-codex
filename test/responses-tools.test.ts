import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCodex from "../extensions/pi-codex.ts";
import {
  appendOpenAIWebSearchCitationSources,
  installOpenAIServerWebSearch,
  installTopLevelResponsesTools,
} from "../src/responses-tools.ts";

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

test("enables native search without retaining a stale client-tool removal notice", () => {
  const clientSearch = { type: "function", name: "web_search" };
  const payload = {
    tools: [read, clientSearch],
    input: [
      {
        role: "developer",
        content:
          "The following tools are no longer available. Do not call them:\n- web_search\n- edit",
      },
      {
        role: "developer",
        content:
          "This is an incremental tools update. Still unavailable: web_search, write.",
      },
      { role: "user", content: "Find the latest release." },
    ],
  };

  assert.equal(installOpenAIServerWebSearch(payload), true);
  assert.deepEqual(payload.tools, [read, { type: "web_search" }]);
  assert.equal(
    payload.input[0].content,
    "The following tools are no longer available. Do not call them:\n- edit",
  );
  assert.equal(
    payload.input[1].content,
    "This is an incremental tools update. Still unavailable: write.",
  );
  assert.equal(payload.input[2].role, "developer");
  assert.match(payload.input[2].content, /OpenAI's hosted web_search tool/);
  assert.match(payload.input[2].content, /Prefer it over MCP web-search tools/);
  assert.equal(payload.input[3].content, "Find the latest release.");
  assert.equal(installOpenAIServerWebSearch(payload), false);
  assert.deepEqual(payload.tools, [read, { type: "web_search" }]);
  assert.equal(
    payload.input.filter(
      (message) =>
        message.role === "developer" &&
        message.content === payload.input[2].content,
    ).length,
    1,
  );
});

test("removes an empty removal notice before injecting the native search instruction", () => {
  const payload = {
    input: [
      {
        role: "developer",
        content: "The following tools are no longer available. Do not call them:\n- web_search",
      },
      { role: "user", content: "Find the latest release." },
    ],
  };

  installOpenAIServerWebSearch(payload);
  assert.equal(payload.input.length, 2);
  assert.equal(payload.input[0].role, "developer");
  assert.match(payload.input[0].content, /OpenAI's hosted web_search tool/);
  assert.equal(payload.input[1].role, "user");
});

test("adds clickable sources for OpenAI citation annotations before Pi parses the response", () => {
  const event = {
    type: "response.output_item.done",
    item: {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "A recent update was announced. [1]",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/releases/(latest)",
              title: "Release [notes]",
            },
            {
              type: "url_citation",
              url: "https://example.com/releases/(latest)",
              title: "Duplicate source",
            },
            {
              type: "url_citation",
              url: "javascript:alert(1)",
              title: "Invalid URL scheme",
            },
          ],
        },
      ],
    },
  };

  assert.equal(appendOpenAIWebSearchCitationSources(event), true);
  assert.equal(
    event.item.content[0].text,
    "A recent update was announced. [1]\n\nSources:\n- [Release \\[notes\\]](https://example.com/releases/%28latest%29)",
  );
  assert.equal(appendOpenAIWebSearchCitationSources(event), false);
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

test("request hook enables hosted search only for selected first-party OpenAI Responses models", async () => {
  type Handler = (event: never, ctx: never) => unknown;
  const handlers = new Map<string, Handler>();
  let active = ["read", "bash", "edit", "write", "web_search"];
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    getActiveTools: () => active,
    setActiveTools(tools: string[]) { active = tools; },
  } as unknown as ExtensionAPI;
  piCodex(pi);
  const sessionStart = handlers.get("session_start");
  const hook = handlers.get("before_provider_request");
  assert.ok(sessionStart);
  assert.ok(hook);

  const firstParty = {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
  };
  const firstPartyContext = {
    model: firstParty,
    sessionManager: { getBranch: () => [] },
  };
  await sessionStart({} as never, firstPartyContext as never);

  const hostedPayload: Record<string, unknown> = {
    input: [{ role: "user", content: "Search this." }],
  };
  await hook({ payload: hostedPayload } as never, firstPartyContext as never);
  assert.deepEqual(hostedPayload.tools, [{ type: "web_search" }]);

  const proxyPayload: Record<string, unknown> = {
    input: [{ role: "user", content: "Search this." }],
  };
  const proxyContext = {
    ...firstPartyContext,
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { baseUrl: "https://proxy.example/v1" } };
      },
    },
  };
  await hook(
    { payload: proxyPayload } as never,
    proxyContext as never,
  );
  assert.equal(proxyPayload.tools, undefined);

  const unsupportedReasoningPayload: Record<string, unknown> = {
    input: [{ role: "user", content: "Search this." }],
    reasoning: { effort: "minimal" },
  };
  await hook(
    { payload: unsupportedReasoningPayload } as never,
    { ...firstPartyContext, model: { ...firstParty, id: "gpt-5" } } as never,
  );
  assert.equal(unsupportedReasoningPayload.tools, undefined);

  const inactiveHandlers = new Map<string, Handler>();
  const inactivePi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Handler) { inactiveHandlers.set(name, handler); },
    getActiveTools: () => ["read", "bash", "edit", "write"],
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  piCodex(inactivePi);
  const inactiveSessionStart = inactiveHandlers.get("session_start");
  const inactiveHook = inactiveHandlers.get("before_provider_request");
  assert.ok(inactiveSessionStart);
  assert.ok(inactiveHook);
  await inactiveSessionStart({} as never, firstPartyContext as never);
  const inactivePayload: Record<string, unknown> = {
    input: [{ role: "user", content: "Search this." }],
  };
  await inactiveHook(
    { payload: inactivePayload } as never,
    firstPartyContext as never,
  );
  assert.equal(inactivePayload.tools, undefined);

  const streamHook = handlers.get("provider_stream_event");
  assert.ok(streamHook);
  const citationEvent = {
    type: "response.output_item.done",
    item: {
      type: "message",
      content: [{
        type: "output_text",
        text: "Example result",
        annotations: [{
          type: "url_citation",
          url: "https://example.com",
          title: "Example",
        }],
      }],
    },
  };
  streamHook({
    provider: "openai",
    api: "openai-responses",
    data: citationEvent,
  } as never, {} as never);
  assert.match(citationEvent.item.content[0].text, /\[Example\]\(https:\/\/example\.com\/\)/);
});
