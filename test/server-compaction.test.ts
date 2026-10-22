import assert from "node:assert/strict";
import test from "node:test";
import {
  SettingsManager,
  convertToLlm,
  SessionManager,
  shouldCompact,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import piCodex, {
  CODEX_SOL_RESERVE_TOKENS,
} from "../extensions/pi-codex.ts";
import {
  installServerCompactionCheckpoint,
  installServerCompactionContextManagement,
  isOpenAIServerCompactionModel,
  isServerCompactionCandidate,
  isServerCompactionDetails,
  SERVER_COMPACTION_KIND,
  SERVER_COMPACTION_VERSION,
  serverCompactionMarker,
  serverCompactionThreshold,
  serverCompactionTokensBefore,
  updateServerCompactionCapture,
  type ServerCompactionDetails,
} from "../src/remote-compaction.ts";

type Handler = (...args: any[]) => any;

function createHarness(options: { compactionEnabled?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => [] as string[],
    getAllTools: () => [],
    setActiveTools() {},
    getSettings: () => ({
      compaction: { enabled: options.compactionEnabled ?? true },
    }),
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);
  return { handlers, pi };
}

function serverModel(overrides: Record<string, unknown> = {}): any {
  return {
    id: "gpt-6-sol",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function createContext(
  model: any,
  options: {
    branch?: any[];
    providerBaseUrl?: string | null;
    appendCompaction?: boolean;
  } = {},
) {
  const appends: any[][] = [];
  const ctx = {
    model,
    thinkingLevel: "off",
    getSystemPrompt: () => "system",
    hasUI: false,
    modelRegistry: {
      async getProviderAuth() {
        if (options.providerBaseUrl === null) return undefined;
        return {
          auth: { baseUrl: options.providerBaseUrl ?? model.baseUrl },
          source: "test",
        };
      },
    },
    sessionManager: {
      getBranch: () => options.branch ?? [],
      getSessionId: () => "session-test",
      ...(options.appendCompaction === false
        ? {}
        : {
            appendCompaction(...args: any[]) {
              appends.push(args);
              return "compaction-entry";
            },
          }),
    },
  };
  return { ctx, appends };
}

function detailsFor(checkpointId: string, item: any): ServerCompactionDetails {
  return {
    type: SERVER_COMPACTION_KIND,
    version: SERVER_COMPACTION_VERSION,
    checkpointId,
    item,
    modelId: "gpt-6-sol",
  };
}

function markerMessage(marker: string): any {
  return {
    role: "user",
    content: [{ type: "input_text", text: marker }],
  };
}

test("server compaction predicate identifies the first-party openai Responses connection", () => {
  assert.equal(isOpenAIServerCompactionModel(serverModel()), true);
  assert.equal(
    isOpenAIServerCompactionModel(serverModel({ baseUrl: "https://api.openai.com/v1/" })),
    true,
  );
  assert.equal(
    isOpenAIServerCompactionModel(serverModel({ provider: "openai-codex" })),
    false,
  );
  assert.equal(
    isOpenAIServerCompactionModel(serverModel({ api: "openai-completions" })),
    false,
  );
  assert.equal(
    isOpenAIServerCompactionModel(serverModel({ baseUrl: "https://proxy.test/v1" })),
    false,
  );
  assert.equal(
    isOpenAIServerCompactionModel(serverModel(), "https://proxy.test/v1"),
    false,
  );
  assert.equal(
    isOpenAIServerCompactionModel(
      serverModel({ baseUrl: "https://proxy.test/v1" }),
      "https://api.openai.com/v1",
    ),
    true,
  );
  assert.equal(
    isOpenAIServerCompactionModel(
      serverModel({ compat: { supportsServerCompaction: false } }),
    ),
    false,
  );
  assert.equal(
    isOpenAIServerCompactionModel(serverModel({ supportsServerCompaction: false })),
    false,
  );
  assert.equal(isOpenAIServerCompactionModel(undefined), false);

  // Candidates still resolve provider auth; the effective-base-URL check is
  // what excludes proxies.
  assert.equal(
    isServerCompactionCandidate(serverModel({ baseUrl: "https://proxy.test/v1" })),
    true,
  );
  assert.equal(isServerCompactionCandidate(serverModel({ provider: "openai-codex" })), false);
  assert.equal(
    isServerCompactionCandidate(serverModel({ compat: { supportsServerCompaction: false } })),
    false,
  );
});

test("server compaction threshold is 90% of the window and never below 1000", () => {
  assert.equal(serverCompactionThreshold(272_000), 244_800);
  assert.equal(serverCompactionThreshold(128_000), 115_200);
  assert.equal(serverCompactionThreshold(999), 1_000);
  assert.equal(serverCompactionThreshold(0), 1_000);
  assert.equal(serverCompactionThreshold(Number.NaN), 1_000);
  assert.equal(serverCompactionThreshold(Number.POSITIVE_INFINITY), 1_000);
});

test("server compaction context_management is added once and can be disabled", () => {
  const payload: any = { input: [] };
  installServerCompactionContextManagement(payload, 272_000);
  assert.deepEqual(payload.context_management, [
    { type: "compaction", compact_threshold: 244_800 },
  ]);

  const existing: any = {
    context_management: [{ type: "compaction", compact_threshold: 5_000 }],
  };
  installServerCompactionContextManagement(existing, 272_000);
  assert.deepEqual(existing.context_management, [
    { type: "compaction", compact_threshold: 5_000 },
  ]);

  const disabled: any = { input: [] };
  installServerCompactionContextManagement(disabled, 272_000, false);
  assert.equal(Object.hasOwn(disabled, "context_management"), false);

  const notObject: unknown = "payload";
  assert.equal(
    installServerCompactionContextManagement(notObject, 272_000),
    notObject,
  );
});

test("server checkpoint replaces exactly one marker and ignores stale input", () => {
  const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  const details = detailsFor("cp-1", item);
  const marker = serverCompactionMarker("cp-1");
  const tail = { role: "user", content: [{ type: "input_text", text: "tail" }] };

  const payload: any = { input: [markerMessage(marker), tail] };
  installServerCompactionCheckpoint(payload, details);
  assert.deepEqual(payload.input, [item, tail]);

  const absent: any = { input: [tail] };
  const absentSnapshot = structuredClone(absent);
  installServerCompactionCheckpoint(absent, details);
  assert.deepEqual(absent, absentSnapshot);

  const duplicated: any = {
    input: [markerMessage(marker), markerMessage(marker), tail],
  };
  const duplicatedSnapshot = structuredClone(duplicated);
  installServerCompactionCheckpoint(duplicated, details);
  assert.deepEqual(duplicated, duplicatedSnapshot);

  const repeatedInOneItem: any = {
    input: [markerMessage(`${marker} ${marker}`), tail],
  };
  const repeatedSnapshot = structuredClone(repeatedInOneItem);
  installServerCompactionCheckpoint(repeatedInOneItem, details);
  assert.deepEqual(repeatedInOneItem, repeatedSnapshot);

  const stale: any = {
    input: [markerMessage(serverCompactionMarker("older-checkpoint")), tail],
  };
  const staleSnapshot = structuredClone(stale);
  installServerCompactionCheckpoint(stale, details);
  assert.deepEqual(stale, staleSnapshot);

  const malformed: any = { input: [markerMessage(marker)] };
  const malformedSnapshot = structuredClone(malformed);
  installServerCompactionCheckpoint(malformed, {
    ...details,
    item: null as any,
  });
  assert.deepEqual(malformed, malformedSnapshot);
});

test("server checkpoint replacement works through pi's compaction projection", async () => {
  const { convertResponsesMessages } = await import(
    "../src/vendor/openai-responses-shared.mjs"
  );
  const session = SessionManager.inMemory("/tmp/pi-codex-server-compaction-test");
  const timestamp = Date.now();
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "before compaction" }],
    timestamp,
  } as any);
  const assistantId = session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "retained tail" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: timestamp + 1,
  } as any);
  const item = { type: "compaction", id: "cmp_real", encrypted_content: "opaque" };
  const details = detailsFor("cp-real", item);
  session.appendCompaction(
    serverCompactionMarker("cp-real"),
    assistantId,
    12_345,
    details,
    true,
  );

  const projected = session.buildSessionProjection();
  const input = (convertResponsesMessages as any)(
    serverModel(),
    { messages: convertToLlm(projected.messages) },
    new Set(["openai"]),
    { includeSystemPrompt: false, grammarToolInputProperties: new Map() },
  ) as any[];

  // Pi projects the compaction entry as a wrapped summary message. The marker
  // is still present in the outgoing input, so the request hook can swap it
  // for the opaque server item.
  assert.equal(input.length, 2);
  assert.match(JSON.stringify(input[0]), /pi-codex server compaction cp-real/);
  const payload = { input };
  installServerCompactionCheckpoint(payload, details);
  assert.deepEqual(payload.input[0], item);
  assert.equal(payload.input.length, 2);
  assert.equal((payload.input[1] as any).role, "assistant");
});

test("server compaction details are distinguishable from legacy checkpoints", () => {
  const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  assert.equal(isServerCompactionDetails(detailsFor("cp-1", item)), true);
  assert.equal(
    isServerCompactionDetails({
      type: "pi-codex-remote-compaction",
      version: 2,
      checkpointId: "cp-1",
      endpoint: "https://example.test",
      output: [],
    }),
    false,
  );
  assert.equal(isServerCompactionDetails({ ...detailsFor("cp-1", item), item: undefined }), false);
  assert.equal(isServerCompactionDetails({ ...detailsFor("cp-1", item), checkpointId: "" }), false);
});

test("stream capture keeps the last compaction item and completion usage", () => {
  const first = { type: "compaction", id: "cmp_1", encrypted_content: "one" };
  const second = { type: "compaction", id: "cmp_2", encrypted_content: "two" };

  let capture = updateServerCompactionCapture(undefined, {
    type: "response.output_item.done",
    item: first,
  });
  assert.deepEqual(capture, { item: first });

  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.done",
    item: second,
  });
  assert.equal(capture?.item?.id, "cmp_2");

  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.done",
    item: { type: "message", content: "not a compaction" },
  });
  assert.equal(capture?.item?.id, "cmp_2");

  const usage = { input_tokens: 8_689, output_tokens: 20 };
  capture = updateServerCompactionCapture(capture, {
    type: "response.completed",
    response: { output: [first, second], usage },
  });
  assert.equal(capture?.item?.id, "cmp_2");
  assert.deepEqual(capture?.tokenUsage, usage);
});

test("stream capture uses response.completed output as a fallback", () => {
  const first = { type: "compaction", id: "cmp_1", encrypted_content: "one" };
  const second = { type: "compaction", id: "cmp_2", encrypted_content: "two" };
  const usage = { input_tokens: 1_000, output_tokens: 10 };

  const fromOutput = updateServerCompactionCapture(undefined, {
    type: "response.completed",
    response: { output: [first, second] },
  });
  assert.equal(fromOutput?.item?.id, "cmp_2");
  assert.equal(fromOutput?.tokenUsage, undefined);

  const previous = updateServerCompactionCapture(undefined, {
    type: "response.output_item.done",
    item: first,
  });
  const withUsage = updateServerCompactionCapture(previous, {
    type: "response.completed",
    response: { output: [], usage },
  });
  assert.equal(withUsage?.item?.id, "cmp_1");
  assert.deepEqual(withUsage?.tokenUsage, usage);

  const usageOnly = updateServerCompactionCapture(undefined, {
    type: "response.completed",
    response: { usage },
  });
  assert.deepEqual(usageOnly, { tokenUsage: usage });

  assert.equal(
    updateServerCompactionCapture(undefined, {
      type: "response.completed",
      response: { output: [] },
    }),
    undefined,
  );
  assert.equal(
    updateServerCompactionCapture(undefined, {
      type: "response.created",
      response: { output: [first] },
    }),
    undefined,
  );
});

test("tokensBefore prefers input tokens and falls back to total tokens", () => {
  assert.equal(serverCompactionTokensBefore({ input_tokens: 8_689 }), 8_689);
  assert.equal(serverCompactionTokensBefore({ total_tokens: 9_000 }), 9_000);
  assert.equal(serverCompactionTokensBefore(undefined), 0);
});

test("request hook installs the latest checkpoint and 90% context management", async () => {
  const { handlers } = createHarness();
  const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  const details = detailsFor("cp-1", item);
  const marker = serverCompactionMarker("cp-1");
  const tail = { role: "user", content: [{ type: "input_text", text: "tail" }] };
  const { ctx } = createContext(serverModel(), {
    branch: [{ type: "compaction", details }],
  });
  const payload: any = { input: [markerMessage(marker), tail] };

  await handlers.get("before_provider_request")?.({ payload }, ctx);

  assert.deepEqual(payload.input, [item, tail]);
  assert.deepEqual(payload.context_management, [
    { type: "compaction", compact_threshold: 244_800 },
  ]);
});

test("request hook respects an existing context_management field", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  const contextManagement = [{ type: "compaction", compact_threshold: 5_000 }];
  const payload: any = { input: [], context_management: contextManagement };

  await handlers.get("before_provider_request")?.({ payload }, ctx);

  assert.equal(payload.context_management, contextManagement);
});

test("request hook adds nothing when compaction is disabled or unsupported", async () => {
  const disabled = createHarness({ compactionEnabled: false });
  const disabledCtx = createContext(serverModel());
  const disabledPayload: any = { input: [] };
  await disabled.handlers
    .get("before_provider_request")
    ?.({ payload: disabledPayload }, disabledCtx.ctx);
  assert.equal(Object.hasOwn(disabledPayload, "context_management"), false);

  const enabled = createHarness();
  const proxied = createContext(serverModel(), {
    providerBaseUrl: "https://proxy.test/v1",
  });
  const proxiedPayload: any = { input: [] };
  await enabled.handlers
    .get("before_provider_request")
    ?.({ payload: proxiedPayload }, proxied.ctx);
  assert.equal(Object.hasOwn(proxiedPayload, "context_management"), false);

  const proxiedModel = createContext(
    serverModel({ baseUrl: "https://proxy.test/v1" }),
  );
  const proxiedModelPayload: any = { input: [] };
  await enabled.handlers
    .get("before_provider_request")
    ?.({ payload: proxiedModelPayload }, proxiedModel.ctx);
  assert.equal(Object.hasOwn(proxiedModelPayload, "context_management"), false);

  const noAppend = createContext(serverModel(), { appendCompaction: false });
  const noAppendPayload: any = { input: [] };
  const noAppendPayloadAgain: any = { input: [] };
  const notices: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    notices.push(String(chunk));
    return true;
  }) as any;
  try {
    await enabled.handlers
      .get("before_provider_request")
      ?.({ payload: noAppendPayload }, noAppend.ctx);
    await enabled.handlers
      .get("before_provider_request")
      ?.({ payload: noAppendPayloadAgain }, noAppend.ctx);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(Object.hasOwn(noAppendPayload, "context_management"), false);
  assert.equal(Object.hasOwn(noAppendPayloadAgain, "context_management"), false);
  assert.equal(
    notices.filter((notice) => notice.includes("server-side compaction disabled")).length,
    1,
  );
});

test("persists one server checkpoint per turn and clears it at every boundary", async () => {
  const { handlers } = createHarness();
  const { ctx, appends } = createContext(serverModel());
  const request = handlers.get("before_provider_request")!;
  const streamEvent = handlers.get("provider_stream_event")!;
  const turnStart = handlers.get("turn_start")!;
  const turnEnd = handlers.get("turn_end")!;
  const agentEnd = handlers.get("agent_end")!;
  const sessionStart = handlers.get("session_start")!;
  const first = { type: "compaction", id: "cmp_1", encrypted_content: "one" };
  const second = { type: "compaction", id: "cmp_2", encrypted_content: "two" };
  const usage = { input_tokens: 8_689, output_tokens: 20 };
  const payload = () => ({ input: [] as unknown[] });

  async function capture(item: any, tokenUsage?: Record<string, unknown>) {
    await request({ payload: payload() }, ctx);
    streamEvent({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-6-sol",
      data: { type: "response.output_item.done", item },
    });
    if (tokenUsage) {
      streamEvent({
        provider: "openai",
        api: "openai-responses",
        model: "gpt-6-sol",
        data: { type: "response.completed", response: { usage: tokenUsage } },
      });
    }
  }

  await capture(first, usage);
  turnEnd({ messageEntryId: "assistant-entry-1" }, ctx);
  assert.equal(appends.length, 1);
  const [summary, firstKeptEntryId, tokensBefore, details, fromHook, piUsage] =
    appends[0];
  assert.match(summary, /^\[pi-codex server compaction [0-9a-f-]{36}\]$/);
  assert.equal(firstKeptEntryId, "assistant-entry-1");
  assert.equal(tokensBefore, 8_689);
  assert.equal(details.type, "pi-codex-server-compaction");
  assert.equal(details.version, 1);
  assert.equal(details.item.id, "cmp_1");
  assert.equal(details.modelId, "gpt-6-sol");
  assert.deepEqual(details.tokenUsage, usage);
  assert.equal(fromHook, true);
  assert.equal(piUsage.input, 8_689);
  assert.equal(piUsage.output, 20);

  // A second turn_end without a capture must not append again.
  turnEnd({ messageEntryId: "assistant-entry-1" }, ctx);
  assert.equal(appends.length, 1);

  // A capture from an aborted/retried turn is discarded at turn_start,
  // agent_end, and session_start.
  await capture(first);
  turnStart({ turnIndex: 1, timestamp: 1 });
  turnEnd({ messageEntryId: "assistant-entry-2" }, ctx);
  assert.equal(appends.length, 1);

  await capture(first);
  agentEnd({ messages: [] });
  turnEnd({ messageEntryId: "assistant-entry-2" }, ctx);
  assert.equal(appends.length, 1);

  await capture(first);
  await sessionStart({}, ctx);
  turnEnd({ messageEntryId: "assistant-entry-2" }, ctx);
  assert.equal(appends.length, 1);

  // A retried provider request resets the slot and re-captures; only the last
  // item is committed once.
  await request({ payload: payload() }, ctx);
  streamEvent({
    provider: "openai",
    api: "openai-responses",
    model: "gpt-6-sol",
    data: { type: "response.output_item.done", item: first },
  });
  await request({ payload: payload() }, ctx);
  streamEvent({
    provider: "openai",
    api: "openai-responses",
    model: "gpt-6-sol",
    data: { type: "response.output_item.done", item: second },
  });
  turnEnd({ messageEntryId: "assistant-entry-3" }, ctx);
  assert.equal(appends.length, 2);
  assert.equal(appends[1][3].item.id, "cmp_2");
});

test("server models suppress the local threshold but keep local summarization usable", async () => {
  const { handlers } = createHarness();
  const settings = SettingsManager.inMemory({
    compaction: { reserveTokens: 8_192 },
  });
  const server = serverModel();
  const serverContext = createContext(server);
  await handlers.get("session_start")?.({}, serverContext.ctx);

  assert.equal(settings.getCompactionSettings(server).reserveTokens, 0);
  assert.equal(shouldCompact(244_800, 272_000, settings.getCompactionSettings(server)), false);
  assert.equal(shouldCompact(272_001, 272_000, settings.getCompactionSettings(server)), true);

  const preparation: any = {
    settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 },
  };
  const result = await handlers.get("session_before_compact")?.(
    {
      preparation,
      branchEntries: [],
      customInstructions: undefined,
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    serverContext.ctx,
  );
  assert.equal(result, undefined, "manual /compact must stay on pi's local path");
  assert.equal(preparation.settings.reserveTokens, 8_192);

  const codex = {
    id: "gpt-5.6-sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    contextWindow: 272_000,
  } as any;
  const codexContext = createContext(codex);
  await handlers.get("model_select")?.(
    { model: codex },
    { ...codexContext.ctx, model: codex },
  );
  assert.equal(
    settings.getCompactionSettings(codex).reserveTokens,
    CODEX_SOL_RESERVE_TOKENS,
  );

  const anthropic = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200_000,
  } as any;
  const anthropicContext = createContext(anthropic);
  await handlers.get("model_select")?.(
    { model: anthropic },
    { ...anthropicContext.ctx, model: anthropic },
  );
  assert.equal(settings.getCompactionSettings(anthropic).reserveTokens, 8_192);
});
