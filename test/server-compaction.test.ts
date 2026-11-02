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
  isFirstPartyOpenAIEndpoint,
  isOpenAIServerCompactionModel,
  isServerCompactionCandidate,
  isServerCompactionDetails,
  MIN_SERVER_COMPACTION_PI_VERSION,
  piSupportsServerCompaction,
  prependServerCompactionCheckpoint,
  SERVER_COMPACTION_KIND,
  SERVER_COMPACTION_VERSION,
  serverCompactionMarker,
  serverCompactionThreshold,
  updateServerCompactionCapture,
  type ServerCompactionDetails,
} from "../src/remote-compaction.ts";

type Handler = (...args: any[]) => any;

function createHarness(
  options: {
    compactionEnabled?: boolean;
    settingsError?: Error;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => [] as string[],
    getAllTools: () => [],
    setActiveTools() {},
    getSettings: () => {
      if (options.settingsError) throw options.settingsError;
      return {
        compaction: { enabled: options.compactionEnabled ?? true },
      };
    },
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
    providerAuthError?: Error;
    appendCompaction?: boolean;
    apiKey?: string;
    authError?: string;
  } = {},
) {
  const directAppends: any[][] = [];
  const ctx = {
    model,
    thinkingLevel: "off",
    getSystemPrompt: () => "system",
    hasUI: false,
    modelRegistry: {
      async getProviderAuth() {
        if (options.providerAuthError) throw options.providerAuthError;
        if (options.providerBaseUrl === null) return undefined;
        return {
          auth: { baseUrl: options.providerBaseUrl ?? model.baseUrl },
          source: "test",
        };
      },
      async getApiKeyAndHeaders() {
        if (options.authError !== undefined) {
          return { ok: false, error: options.authError };
        }
        return { ok: true, apiKey: options.apiKey ?? "test-key", headers: {} };
      },
    },
    sessionManager: {
      getBranch: () => options.branch ?? [],
      getSessionId: () => "session-test",
      ...(options.appendCompaction === false
        ? {}
        : {
            appendCompaction(...args: any[]) {
              directAppends.push(args);
              return "compaction-entry";
            },
          }),
    },
  };
  return { ctx, directAppends };
}

function detailsFor(
  checkpointId: string,
  item: any,
  modelId = "gpt-6-sol",
): ServerCompactionDetails {
  return {
    type: SERVER_COMPACTION_KIND,
    version: SERVER_COMPACTION_VERSION,
    checkpointId,
    item,
    modelId,
  };
}

function markerMessage(marker: string): any {
  return {
    role: "user",
    content: [{ type: "input_text", text: marker }],
  };
}

test("shared first-party endpoint predicate has an explicit missing-URL policy", () => {
  for (const missingUrlIsFirstParty of [true, false]) {
    assert.equal(
      isFirstPartyOpenAIEndpoint(undefined, missingUrlIsFirstParty),
      missingUrlIsFirstParty,
    );
    for (const url of [
      "https://api.openai.com/v1",
      "https://api.openai.com/v1/",
      "  https://api.openai.com/v1/// \n",
    ]) {
      assert.equal(isFirstPartyOpenAIEndpoint(url, missingUrlIsFirstParty), true, url);
    }
    for (const url of [
      "",
      "  ",
      "https://proxy.test/v1",
      "https://api.openai.com/v1/responses",
      "https://api.openai.com.proxy.test/v1",
      "http://api.openai.com/v1",
    ]) {
      assert.equal(isFirstPartyOpenAIEndpoint(url, missingUrlIsFirstParty), false, url);
    }
  }
});

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
  assert.equal(isOpenAIServerCompactionModel(serverModel({ baseUrl: undefined })), false);
  assert.equal(
    isOpenAIServerCompactionModel(serverModel({ baseUrl: undefined }), "https://api.openai.com/v1"),
    true,
  );

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

test("server compaction requires the pi 0.99 stream events and turn_end drafts", () => {
  assert.equal(MIN_SERVER_COMPACTION_PI_VERSION, "0.99.0");
  // provider_stream_event does not exist in 0.87 and first appears in 0.99.
  assert.equal(piSupportsServerCompaction("0.87.0"), false);
  assert.equal(piSupportsServerCompaction("0.98.9"), false);
  assert.equal(piSupportsServerCompaction("0.99.0"), true);
  assert.equal(piSupportsServerCompaction("0.99.0-beta.2"), true);
  assert.equal(piSupportsServerCompaction("1.3.0"), true);
  assert.equal(piSupportsServerCompaction("2.0.0"), true);
  // The gate fails closed: an unparsable host version must not suppress local
  // compaction on the assumption that the event exists.
  assert.equal(piSupportsServerCompaction("unknown"), false);
  assert.equal(piSupportsServerCompaction("0.99"), false);
  assert.equal(piSupportsServerCompaction(""), false);
});

test("server compaction defaults to the probed gpt-6 family and needs an opt-in elsewhere", () => {
  // Probed 2026-10-23 on the first-party connection: context_management was
  // accepted by gpt-6-sol/luna/astra and gpt-6.1-sol. Pre-GPT-6 catalog models
  // are rejected by that connection at the model level, so their parameter
  // acceptance is UNVERIFIED and they stay off by default.
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-6-sol" })), true);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-6-astra" })), true);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-6-luna" })), true);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-6.1-sol" })), true);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-6" })), true);

  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-5.1" })), false);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-5.3-codex" })), false);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-4.1" })), false);
  assert.equal(isServerCompactionCandidate(serverModel({ id: "o3" })), false);
  // The family match is anchored: gpt-daybreak/gpt-6x must not sneak in.
  assert.equal(
    isServerCompactionCandidate(serverModel({ id: "gpt-daybreak-blue-latest" })),
    false,
  );
  assert.equal(isServerCompactionCandidate(serverModel({ id: "gpt-60" })), false);

  // Explicit opt-in enables an unprobed model; explicit opt-out wins everywhere.
  assert.equal(
    isServerCompactionCandidate(
      serverModel({ id: "gpt-4.1", compat: { supportsServerCompaction: true } }),
    ),
    true,
  );
  assert.equal(
    isServerCompactionCandidate(
      serverModel({ id: "gpt-4.1", supportsServerCompaction: true }),
    ),
    true,
  );
  assert.equal(
    isServerCompactionCandidate(
      serverModel({ id: "gpt-6-sol", supportsServerCompaction: false }),
    ),
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
    content: [
      { type: "text", text: "before the checkpoint" },
      { type: "text", text: "retained tail" },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: timestamp + 1,
  } as any);
  // The server checkpoint covers the first text block; only the continuation
  // after the compaction item belongs in the next request.
  session.appendContextEdit(assistantId, {
    content: [{ type: "text", text: "retained tail" }],
  });
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
  assert.match(JSON.stringify(payload.input[1]), /retained tail/);
  assert.doesNotMatch(JSON.stringify(payload.input), /before the checkpoint/);
});

test("a committed server checkpoint keeps tool results whose calls it absorbed", async () => {
  const { convertResponsesMessages } = await import(
    "../src/vendor/openai-responses-shared.mjs"
  );
  const session = SessionManager.inMemory("/tmp/pi-codex-absorbed-tool-result-test");
  const timestamp = Date.now();
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "run commands" }],
    timestamp,
  } as any);
  const assistantId = session.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "before the checkpoint" },
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "bash",
        arguments: { command: "ls" },
      },
      { type: "text", text: "after the checkpoint" },
      {
        type: "toolCall",
        id: "call_2|fc_2",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
    timestamp: timestamp + 1,
  } as any);
  session.appendMessage({
    role: "toolResult",
    toolCallId: "call_1|fc_1",
    toolName: "bash",
    content: [{ type: "text", text: "listing" }],
    isError: false,
    timestamp: timestamp + 2,
  } as any);
  session.appendMessage({
    role: "toolResult",
    toolCallId: "call_2|fc_2",
    toolName: "bash",
    content: [{ type: "text", text: "/tmp" }],
    isError: false,
    timestamp: timestamp + 3,
  } as any);

  // The drafts turn_end returns for this capture: trim the pre-checkpoint
  // assistant prefix, but leave both tool-result entries in model context.
  session.appendContextEdit(assistantId, {
    content: [
      { type: "text", text: "after the checkpoint" },
      {
        type: "toolCall",
        id: "call_2|fc_2",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ],
  });
  const item = { type: "compaction", id: "cmp_orphan", encrypted_content: "opaque" };
  const details = detailsFor("cp-orphan", item);
  session.appendCompaction(
    serverCompactionMarker("cp-orphan"),
    assistantId,
    12_345,
    details,
    true,
  );

  const projected = session.buildSessionProjection();
  const payload: any = {
    input: (convertResponsesMessages as any)(
      serverModel(),
      { messages: convertToLlm(projected.messages) },
      new Set(["openai"]),
      { includeSystemPrompt: false, grammarToolInputProperties: new Map() },
    ),
  };
  installServerCompactionCheckpoint(payload, details);

  // Only items before the newest compaction may be pruned. call_1's
  // function_call was absorbed into the checkpoint, but its output happened
  // after it and the server retains the call inside the opaque item, so the
  // pair is replay-valid. Dropping the output would lose real conversation
  // content the checkpoint never saw.
  assert.deepEqual(payload.input[0], item);
  const calls = payload.input.filter((entry: any) => entry.type === "function_call");
  const outputs = payload.input.filter(
    (entry: any) => entry.type === "function_call_output",
  );
  assert.deepEqual(calls.map((call: any) => call.call_id), ["call_2"]);
  assert.deepEqual(
    outputs.map((output: any) => output.call_id),
    ["call_1", "call_2"],
  );
  assert.doesNotMatch(JSON.stringify(payload.input), /before the checkpoint/);
});

test("an older server checkpoint survives a later local compaction", async () => {
  const { convertResponsesMessages } = await import(
    "../src/vendor/openai-responses-shared.mjs"
  );
  const session = SessionManager.inMemory("/tmp/pi-codex-local-compaction-test");
  const timestamp = Date.now();
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "history before the checkpoint" }],
    timestamp,
  } as any);
  const firstAssistant = session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer before the checkpoint" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: timestamp + 1,
  } as any);
  const item = { type: "compaction", id: "cmp_old", encrypted_content: "opaque" };
  const details = detailsFor("cp-old", item);
  session.appendCompaction(
    serverCompactionMarker("cp-old"),
    firstAssistant,
    10_000,
    details,
    true,
  );
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "later question" }],
    timestamp: timestamp + 2,
  } as any);
  const secondAssistant = session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "later answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: timestamp + 3,
  } as any);
  // Pi feeds the previous summary (the opaque marker) into the local
  // summarizer, so the generated summary can retain that text. The request
  // hook must prepend the checkpoint, not replace the whole local summary.
  session.appendCompaction(
    `${serverCompactionMarker("cp-old")}\n\nlocal summary of the later question and answer`,
    secondAssistant,
    500,
    { readFiles: [], modifiedFiles: [] },
    true,
  );

  const projected = session.buildSessionProjection();
  const input = (convertResponsesMessages as any)(
    serverModel(),
    { messages: convertToLlm(projected.messages) },
    new Set(["openai"]),
    { includeSystemPrompt: false, grammarToolInputProperties: new Map() },
  ) as any[];
  assert.equal(input.length, 2);
  assert.match(JSON.stringify(input[0]), /local summary/);

  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel(), { branch: session.getBranch() });
  const payload: any = { input };
  await handlers.get("before_provider_request")?.({ payload }, ctx);

  assert.deepEqual(payload.input[0], item);
  assert.match(JSON.stringify(payload.input[1]), /pi-codex server compaction cp-old/);
  assert.match(JSON.stringify(payload.input[1]), /local summary/);
  assert.match(JSON.stringify(payload.input[2]), /later answer/);
  assert.equal(payload.input.length, 3);
  assert.doesNotMatch(JSON.stringify(payload.input), /history before the checkpoint/);
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

test("stream capture tracks assistant content emitted before the latest checkpoint", () => {
  const compaction = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  let capture = updateServerCompactionCapture(undefined, {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [] },
  });
  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      type: "function_call",
      call_id: "call_1",
      id: "fc_1",
      name: "bash",
      arguments: "{}",
    },
  });
  // Duplicate added events for one index must not double-count content.
  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      type: "function_call",
      call_id: "call_1",
      id: "fc_1",
      name: "bash",
      arguments: "{}",
    },
  });
  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.done",
    item: compaction,
  });
  assert.equal(capture?.contentCount, 2);
  assert.equal(capture?.contentCountBefore, 2);

  // A compaction item itself never creates an assistant content block.
  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.added",
    output_index: 2,
    item: compaction,
  });
  assert.equal(capture?.contentCount, 2);

  // The terminal output is authoritative for the boundary.
  capture = updateServerCompactionCapture(capture, {
    type: "response.completed",
    response: {
      output: [{ type: "message", role: "assistant" }, compaction],
      usage: { input_tokens: 1 },
    },
  });
  assert.equal(capture?.contentCountBefore, 1);
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

test("request hook keeps an older checkpoint ahead of a later local summary", async () => {
  const { handlers } = createHarness();
  const item = { type: "compaction", id: "cmp_old", encrypted_content: "opaque" };
  const details = detailsFor("cp-old", item);
  const localSummary = {
    role: "user",
    content: [{ type: "input_text", text: "local summary of the later tail" }],
  };
  const tail = { role: "user", content: [{ type: "input_text", text: "tail" }] };
  const { ctx } = createContext(serverModel(), {
    branch: [
      { type: "compaction", id: "server-entry", details },
      {
        type: "compaction",
        id: "local-entry",
        details: { readFiles: [], modifiedFiles: [] },
      },
    ],
  });
  const payload: any = { input: [localSummary, tail] };

  await handlers.get("before_provider_request")?.({ payload }, ctx);

  assert.deepEqual(payload.input, [item, localSummary, tail]);
  assert.deepEqual(payload.context_management, [
    { type: "compaction", compact_threshold: 244_800 },
  ]);
});

test("a branch summary after the checkpoint still installs the checkpoint", async () => {
  const { handlers } = createHarness();
  const session = SessionManager.inMemory("/tmp/pi-codex-branch-summary");
  const userId = session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "start" }],
    timestamp: Date.now(),
  } as any);
  const item = { type: "compaction", id: "cmp_branch", encrypted_content: "opaque" };
  const details = detailsFor("cp-branch", item);
  session.appendCompaction(
    serverCompactionMarker("cp-branch"),
    userId,
    12_345,
    details,
    true,
  );
  const assistantId = session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "after the checkpoint" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now() + 1,
  } as any);
  // Branching after the checkpoint keeps it on the active path and appends the
  // summary as additive context after it.
  session.branchWithSummary(assistantId, "summary of the abandoned branch");
  assert.equal(session.getBranch().at(-1)?.type, "branch_summary");
  assert.ok(
    session.getBranch().some((entry) => entry.type === "compaction"),
    "the branch summary must not remove the checkpoint from the active path",
  );

  const { ctx } = createContext(serverModel());
  const tail = {
    role: "assistant",
    content: [{ type: "output_text", text: "after the checkpoint" }],
  };
  const summary = {
    role: "user",
    content: [{ type: "input_text", text: "branch summary" }],
  };
  const payload: any = {
    input: [markerMessage(serverCompactionMarker("cp-branch")), tail, summary],
  };

  await handlers
    .get("before_provider_request")
    ?.({ payload }, { ...ctx, sessionManager: session });

  assert.deepEqual(payload.input, [item, tail, summary]);
});

test("a branch summary does not hide an older checkpoint behind a local summary", async () => {
  const { handlers } = createHarness();
  const session = SessionManager.inMemory("/tmp/pi-codex-branch-summary-local");
  const userId = session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "start" }],
    timestamp: Date.now(),
  } as any);
  const item = { type: "compaction", id: "cmp_branch", encrypted_content: "opaque" };
  const details = detailsFor("cp-branch", item);
  const checkpointId = session.appendCompaction(
    serverCompactionMarker("cp-branch"),
    userId,
    12_345,
    details,
    true,
  );
  const summaryId = session.branchWithSummary(
    checkpointId,
    "summary of the abandoned branch",
  );
  session.appendCompaction(
    "local summary of the retained tail",
    summaryId,
    20_000,
    undefined,
    true,
  );
  assert.equal(session.getBranch().at(-1)?.type, "compaction");

  const { ctx } = createContext(serverModel());
  const localSummary = markerMessage("local summary of the retained tail");
  const branchSummary = {
    role: "user",
    content: [{ type: "input_text", text: "branch summary" }],
  };
  const payload: any = { input: [localSummary, branchSummary] };

  await handlers
    .get("before_provider_request")
    ?.({ payload }, { ...ctx, sessionManager: session });

  assert.deepEqual(payload.input, [item, localSummary, branchSummary]);
});

test("prepending an older checkpoint is idempotent", () => {
  const item = { type: "compaction", id: "cmp_old", encrypted_content: "opaque" };
  const details = detailsFor("cp-old", item);
  const summary = markerMessage("local summary");
  const payload: any = { input: [item, summary] };

  prependServerCompactionCheckpoint(payload, details);

  assert.deepEqual(payload.input, [item, summary]);
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
  const disabledNotices = notices.filter((notice) =>
    notice.includes("server-side compaction disabled"),
  );
  assert.equal(disabledNotices.length, 1);
  assert.match(disabledNotices[0], /requires pi >= 0\.99\.0/);
});

test("provider auth failures propagate instead of disabling compaction", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel(), {
    providerAuthError: new Error("credential refresh failed"),
  });
  await assert.rejects(
    () =>
      handlers
        .get("before_provider_request")
        ?.({ payload: { input: [] } }, ctx),
    /credential refresh failed/,
  );
});

test("settings read failures propagate instead of enabling compaction", async () => {
  const { handlers } = createHarness({
    settingsError: new Error("settings read failed"),
  });
  const { ctx } = createContext(serverModel());
  await assert.rejects(
    () =>
      handlers
        .get("before_provider_request")
        ?.({ payload: { input: [] } }, ctx),
    /settings read failed/,
  );
});

test("failed request preparation clears active server compaction state", async () => {
  const settings = SettingsManager.inMemory({
    compaction: { reserveTokens: 8_192 },
  });
  const server = serverModel();
  const reserve = () => settings.getCompactionSettings(server).reserveTokens;

  const healthy = createHarness();
  const healthyCtx = createContext(server);
  await healthy.handlers.get("session_start")?.({}, healthyCtx.ctx);
  assert.equal(reserve(), 0);

  // The settings read fails after the connection checks but before the
  // request carries context_management; local compaction must get its
  // reserve back.
  const badSettings = createHarness({
    settingsError: new Error("settings read failed"),
  });
  const badSettingsCtx = createContext(server);
  await assert.rejects(
    () =>
      badSettings.handlers
        .get("before_provider_request")
        ?.({ payload: { input: [] } }, badSettingsCtx.ctx),
    /settings read failed/,
  );
  assert.equal(reserve(), 8_192);

  // A failed provider-auth lookup leaves the effective connection unknown.
  await healthy.handlers.get("session_start")?.({}, healthyCtx.ctx);
  assert.equal(reserve(), 0);
  const badAuth = createContext(server, {
    providerAuthError: new Error("credential refresh failed"),
  });
  await assert.rejects(
    () =>
      healthy.handlers
        .get("before_provider_request")
        ?.({ payload: { input: [] } }, badAuth.ctx),
    /credential refresh failed/,
  );
  assert.equal(reserve(), 8_192);

  // A model switch refreshes state too; a failed refresh must not retain the
  // previous model's suppression.
  await healthy.handlers.get("session_start")?.({}, healthyCtx.ctx);
  assert.equal(reserve(), 0);
  await assert.rejects(
    () =>
      healthy.handlers
        .get("model_select")
        ?.({ model: server }, { ...badAuth.ctx, model: server }),
    /credential refresh failed/,
  );
  assert.equal(reserve(), 8_192);

  healthy.handlers.get("session_shutdown")?.();
  assert.equal(reserve(), 8_192);
});

test("checkpoint repair runs before every gate; only new compaction is gated", async () => {
  const { handlers } = createHarness();
  const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  const marker = serverCompactionMarker("cp-1");
  const tail = { role: "user", content: [{ type: "input_text", text: "tail" }] };
  const branch = [
    { type: "compaction", id: "server-entry", details: detailsFor("cp-1", item) },
  ];

  // A model-level opt-out still gets the checkpoint: the marker is a
  // placeholder, and keeping it would drop the whole pre-checkpoint
  // conversation. Only context_management is suppressed.
  const optedOut = createContext(
    serverModel({ id: "gpt-6-sol", compat: { supportsServerCompaction: false } }),
    { branch },
  );
  const optedOutPayload: any = { input: [markerMessage(marker), tail] };
  await handlers
    .get("before_provider_request")
    ?.({ payload: optedOutPayload }, optedOut.ctx);
  assert.deepEqual(optedOutPayload.input, [item, tail]);
  assert.equal(Object.hasOwn(optedOutPayload, "context_management"), false);

  // Same for a provider-auth proxy base URL.
  const proxied = createContext(
    serverModel({ id: "gpt-6-sol" }),
    { branch, providerBaseUrl: "https://proxy.test/v1" },
  );
  const proxiedPayload: any = { input: [markerMessage(marker), tail] };
  await handlers
    .get("before_provider_request")
    ?.({ payload: proxiedPayload }, proxied.ctx);
  assert.deepEqual(proxiedPayload.input, [item, tail]);
  assert.equal(Object.hasOwn(proxiedPayload, "context_management"), false);

  // A model outside the probed family defaults to no context_management but
  // an existing checkpoint is still repaired.
  const unprobed = createContext(serverModel({ id: "gpt-4.1" }), {
    branch: [
      {
        type: "compaction",
        id: "server-entry",
        details: detailsFor("cp-1", item, "gpt-4.1"),
      },
    ],
  });
  const unprobedPayload: any = { input: [markerMessage(marker), tail] };
  await handlers
    .get("before_provider_request")
    ?.({ payload: unprobedPayload }, unprobed.ctx);
  assert.deepEqual(unprobedPayload.input, [item, tail]);
  assert.equal(Object.hasOwn(unprobedPayload, "context_management"), false);

  // A failed auth lookup rejects the handler, but the repair already ran:
  // pi's runner catches the error and sends the repaired payload.
  const authFailure = createContext(serverModel({ id: "gpt-6-sol" }), {
    branch,
    providerAuthError: new Error("credential refresh failed"),
  });
  const authFailurePayload: any = { input: [markerMessage(marker), tail] };
  await assert.rejects(
    () =>
      handlers
        .get("before_provider_request")
        ?.({ payload: authFailurePayload }, authFailure.ctx),
    /credential refresh failed/,
  );
  assert.deepEqual(authFailurePayload.input, [item, tail]);
});

test("a model switch after a server checkpoint warns once and still repairs", async () => {
  const { handlers } = createHarness();
  const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  const marker = serverCompactionMarker("cp-1");
  const tail = { role: "user", content: [{ type: "input_text", text: "tail" }] };
  const { ctx } = createContext(serverModel({ id: "gpt-6-luna" }), {
    branch: [
      { type: "compaction", id: "server-entry", details: detailsFor("cp-1", item) },
    ],
  });

  const notices: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    notices.push(String(chunk));
    return true;
  }) as any;
  try {
    for (let index = 0; index < 2; index++) {
      const payload: any = { input: [markerMessage(marker), tail] };
      await handlers
        .get("before_provider_request")
        ?.({ payload }, ctx);
      assert.deepEqual(payload.input, [item, tail]);
      assert.deepEqual(payload.context_management, [
        { type: "compaction", compact_threshold: 244_800 },
      ]);
    }
  } finally {
    process.stderr.write = originalWrite;
  }
  const mismatches = notices.filter((notice) =>
    notice.includes("created with gpt-6-sol"),
  );
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /gpt-6-luna/);
});

test("a server checkpoint cannot be replayed on a codex connection and says so", async () => {
  const { handlers } = createHarness();
  const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
  const marker = serverCompactionMarker("cp-1");
  const codexModel = {
    id: "gpt-5.6-sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    contextWindow: 272_000,
  } as any;
  const { ctx } = createContext(codexModel, {
    branch: [
      { type: "compaction", id: "server-entry", details: detailsFor("cp-1", item) },
    ],
  });
  const payload: any = { input: [markerMessage(marker)] };

  const notices: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    notices.push(String(chunk));
    return true;
  }) as any;
  try {
    await handlers.get("before_provider_request")?.({ payload }, ctx);
  } finally {
    process.stderr.write = originalWrite;
  }
  // The opaque item is not installed into a codex payload, and the failure is
  // visible instead of silent.
  assert.deepEqual(payload.input, [markerMessage(marker)]);
  const notices45 = notices.filter((notice) =>
    notice.includes("cannot be replayed on openai-codex/gpt-5.6-sol"),
  );
  assert.equal(notices45.length, 1);
});

test("persists one server checkpoint per turn and clears it at every boundary", async () => {
  const { handlers } = createHarness();
  const { ctx, directAppends } = createContext(serverModel());
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

  function commit(messageEntryId: string): any | undefined {
    return turnEnd(
      {
        entries: [],
        messageEntryId,
        message: { role: "assistant", content: [] },
        toolResults: [],
      },
      ctx,
    );
  }

  function compactionDraft(result: any): any {
    return result?.entries?.find((entry: any) => entry.type === "compaction");
  }

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
  const firstCommit = compactionDraft(commit("assistant-entry-1"));
  assert.equal(
    directAppends.length,
    0,
    "the checkpoint must go through turn_end drafts so entry_appended fires",
  );
  assert.match(
    firstCommit.summary,
    /^\[pi-codex server compaction [0-9a-f-]{36}\]$/,
  );
  assert.equal(firstCommit.firstKeptEntryId, "assistant-entry-1");
  assert.equal(firstCommit.details.type, "pi-codex-server-compaction");
  assert.equal(firstCommit.details.version, 1);
  assert.equal(firstCommit.details.item.id, "cmp_1");
  assert.equal(firstCommit.details.modelId, "gpt-6-sol");
  assert.deepEqual(firstCommit.details.tokenUsage, usage);
  assert.equal(
    firstCommit.usage,
    undefined,
    "response usage is already on the assistant message; compaction entries must not count it twice",
  );

  // A second turn_end without a capture must not commit again.
  assert.equal(commit("assistant-entry-1"), undefined);

  // A capture from an aborted/retried turn is discarded at turn_start,
  // agent_end, and session_start.
  await capture(first);
  turnStart({ turnIndex: 1, timestamp: 1 });
  assert.equal(commit("assistant-entry-2"), undefined);

  await capture(first);
  agentEnd({ messages: [] });
  assert.equal(commit("assistant-entry-2"), undefined);

  await capture(first);
  await sessionStart({}, ctx);
  assert.equal(commit("assistant-entry-2"), undefined);

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
  const retried = compactionDraft(commit("assistant-entry-3"));
  assert.equal(retried.details.item.id, "cmp_2");
});

test("a cache-warming replay cannot replace the foreground checkpoint", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  const request = handlers.get("before_provider_request")!;
  const streamEvent = handlers.get("provider_stream_event")!;
  const turnStart = handlers.get("turn_start")!;
  const turnEnd = handlers.get("turn_end")!;

  const foreground = { type: "compaction", id: "cmp_fg", encrypted_content: "fg" };
  const warming = { type: "compaction", id: "cmp_warm", encrypted_content: "warm" };
  const foregroundUsage = { input_tokens: 10_100, output_tokens: 20 };
  const warmingUsage = { input_tokens: 9_000, output_tokens: 1 };
  const stream = (data: any) =>
    streamEvent({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-6-sol",
      data,
    });

  turnStart({ turnIndex: 1, timestamp: 1 });
  // The foreground response emits its checkpoint, then pi's cache warmer
  // replays the request with a one-token cap while the foreground stream is
  // still running. The warming request passes through before_provider_request
  // and emits its own checkpoint and terminal event.
  await request({ payload: { input: [], max_output_tokens: 128_000 } }, ctx);
  stream({
    type: "response.output_item.done",
    item: foreground,
  });
  await request({ payload: { input: [], max_output_tokens: 16 } }, ctx);
  stream({
    type: "response.created",
    response: { id: "resp_warm", max_output_tokens: 16, output: [] },
  });
  stream({
    type: "response.output_item.done",
    item: warming,
  });
  stream({
    type: "response.completed",
    response: { id: "resp_warm", output: [warming], usage: warmingUsage },
  });
  stream({
    type: "response.completed",
    response: { id: "resp_fg", output: [foreground], usage: foregroundUsage },
  });
  // A warming stream that already sent response.created before the foreground
  // finished must not append its later output item to the completed foreground
  // capture by inheriting that capture's response id.
  stream({
    type: "response.output_item.done",
    item: warming,
  });
  // A warming stream that started late must not overwrite the completed
  // foreground entry with its own output item before it finishes.
  stream({
    type: "response.created",
    response: { id: "resp_warm_late" },
  });
  stream({
    type: "response.output_item.done",
    item: warming,
  });
  // The warmer may also finish after the foreground response; its late
  // terminal event must not become the turn's checkpoint.
  stream({
    type: "response.completed",
    response: { id: "resp_warm_2", output: [warming], usage: warmingUsage },
  });

  const result = turnEnd(
    {
      entries: [],
      messageEntryId: "assistant-fg",
      message: {
        role: "assistant",
        responseId: "resp_fg",
        stopReason: "stop",
        content: [],
      },
      toolResults: [],
    },
    ctx,
  );
  const compactionDraft = result.entries.find(
    (entry: any) => entry.type === "compaction",
  );
  assert.equal(compactionDraft.details.item.id, "cmp_fg");
  assert.deepEqual(compactionDraft.details.tokenUsage, foregroundUsage);
  assert.equal(compactionDraft.usage, undefined);
});

test("turn_end leaves truncated responses to pi's recovery path", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  const request = handlers.get("before_provider_request")!;
  const streamEvent = handlers.get("provider_stream_event")!;
  const turnStart = handlers.get("turn_start")!;
  const turnEnd = handlers.get("turn_end")!;

  const item = { type: "compaction", id: "cmp_truncated", encrypted_content: "opaque" };
  const stream = (data: any) =>
    streamEvent({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-6-sol",
      data,
    });

  turnStart({ turnIndex: 1, timestamp: 1 });
  await request({ payload: { input: [] } }, ctx);
  stream({ type: "response.output_item.done", item });
  stream({
    type: "response.completed",
    response: {
      id: "resp_truncated",
      output: [item],
      usage: { input_tokens: 10_100, output_tokens: 128_000 },
    },
  });

  // Pi has not yet run its post-run recoverable-length check. Committing a
  // compaction entry here would make the assistant message look older than the
  // new boundary and suppress that check.
  const result = turnEnd(
    {
      entries: [],
      messageEntryId: "assistant-truncated",
      message: {
        role: "assistant",
        responseId: "resp_truncated",
        stopReason: "length",
        content: [{ type: "text", text: "partial output" }],
      },
      toolResults: [],
    },
    ctx,
  );
  assert.equal(result, undefined);

  // The aborted commit path cleared the capture: a later successful turn_end
  // must not commit the truncated response's checkpoint.
  const later = turnEnd(
    {
      entries: [],
      messageEntryId: "assistant-next",
      message: {
        role: "assistant",
        responseId: "resp_truncated",
        stopReason: "stop",
        content: [],
      },
      toolResults: [],
    },
    ctx,
  );
  assert.equal(later, undefined);
});

test("turn_end trims pre-checkpoint assistant output but keeps tool results", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  await handlers
    .get("before_provider_request")
    ?.({ payload: { input: [] } }, ctx);

  const stream = (data: any) =>
    handlers.get("provider_stream_event")?.({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-6-sol",
      data,
    });
  const message = { type: "message", role: "assistant", content: [] };
  const call = {
    type: "function_call",
    call_id: "call_1",
    id: "fc_1",
    name: "bash",
    arguments: "{}",
  };
  const callAfter = {
    type: "function_call",
    call_id: "call_2",
    id: "fc_2",
    name: "bash",
    arguments: "{}",
  };
  stream({ type: "response.output_item.added", output_index: 0, item: message });
  stream({ type: "response.output_item.added", output_index: 1, item: call });
  stream({
    type: "response.output_item.done",
    item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
  });
  stream({ type: "response.output_item.added", output_index: 2, item: message });
  stream({ type: "response.output_item.added", output_index: 3, item: callAfter });

  const before = { type: "text", text: "before the checkpoint" };
  const after = { type: "text", text: "after the checkpoint" };
  const absorbedCall = {
    type: "toolCall",
    id: "call_1|fc_1",
    name: "bash",
    arguments: { command: "ls" },
  };
  const retainedCall = {
    type: "toolCall",
    id: "call_2|fc_2",
    name: "bash",
    arguments: { command: "pwd" },
  };
  const result = handlers.get("turn_end")?.(
    {
      entries: [],
      messageEntryId: "assistant-1",
      message: { role: "assistant", content: [before, absorbedCall, after, retainedCall] },
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "call_1|fc_1",
          toolName: "bash",
          content: [],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_2|fc_2",
          toolName: "bash",
          content: [],
          timestamp: 2,
        },
      ],
      toolResultEntryIds: ["tool-result-1", "tool-result-2"],
    },
    ctx,
  );
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], {
    type: "context_edit",
    targetId: "assistant-1",
    replacement: { content: [after, retainedCall] },
  });
  assert.equal(result.entries[1].type, "compaction");
  assert.equal(result.entries[1].firstKeptEntryId, "assistant-1");
  assert.equal(result.entries[1].details.item.id, "cmp_1");
  // No tool-result entry is edited: both results remain in model context,
  // including the one whose call the checkpoint absorbed.
  assert.equal(
    result.entries.filter((entry: any) => entry.type === "context_edit").length,
    1,
  );
});

test("turn_end commits even when tool result entry ids are unavailable", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  await handlers
    .get("before_provider_request")
    ?.({ payload: { input: [] } }, ctx);
  handlers.get("provider_stream_event")?.({
    provider: "openai",
    api: "openai-responses",
    model: "gpt-6-sol",
    data: {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "bash" },
    },
  });
  handlers.get("provider_stream_event")?.({
    provider: "openai",
    api: "openai-responses",
    model: "gpt-6-sol",
    data: {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
    },
  });

  // Tool results are retained as-is, so their entry ids are no longer part of
  // the commit contract.
  const result = handlers.get("turn_end")!(
    {
      entries: [],
      messageEntryId: "assistant-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1|fc_1",
            name: "bash",
            arguments: {},
          },
          { type: "text", text: "after" },
        ],
      },
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "call_1|fc_1",
          toolName: "bash",
          content: [],
          timestamp: 1,
        },
      ],
      toolResultEntryIds: [],
    },
    ctx,
  );
  assert.equal(
    result.entries.filter((entry: any) => entry.type === "context_edit").length,
    1,
  );
  assert.equal(
    result.entries.find((entry: any) => entry.type === "compaction")?.details
      .item.id,
    "cmp_1",
  );
});

test("turn_end omits the assistant message when the checkpoint covers all output", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  await handlers
    .get("before_provider_request")
    ?.({ payload: { input: [] } }, ctx);

  const stream = (data: any) =>
    handlers.get("provider_stream_event")?.({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-6-sol",
      data,
    });
  stream({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [] },
  });
  stream({
    type: "response.output_item.done",
    item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
  });

  const result = handlers.get("turn_end")?.(
    {
      entries: [],
      messageEntryId: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "only before the checkpoint" }],
      },
      toolResults: [],
    },
    ctx,
  );
  const edit = result.entries.find((entry: any) => entry.type === "context_edit");
  assert.deepEqual(edit, {
    type: "context_edit",
    targetId: "assistant-1",
    replacement: null,
  });
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
      // Overflow recovery is the remaining local fallback on this
      // connection: the manual /compact reason now takes the server fold.
      reason: "overflow",
      willRetry: false,
      signal: new AbortController().signal,
    },
    serverContext.ctx,
  );
  assert.equal(result, undefined, "overflow recovery must stay on pi's local path");
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

// ── Manual (on-demand) server compaction: /compact on the openai connection ──
//
// The 2026-10-29 live probe pinned this path: on the ChatGPT-plan OAuth
// connection the `compaction_trigger` input item is rejected
// (subscription_sharing_unsupported_capability) and /responses/compact is
// unauthorized (hardened_oauth_rule_missing), but a dedicated /responses
// request with context_management forced to the 1000-token minimum compacts
// on demand. The stream may carry several compaction items; the last one
// folds everything, and response.completed may carry an empty output array.

import {
  buildCompactRequest,
  buildServerCompactionHeaders,
  parseServerCompactionManualResponse,
  serverCompactionManualRequest,
  serverCompactionRequestUrl,
} from "../src/remote-compaction.ts";

function manualSse(): string {
  const lines = [
    { type: "response.created", response: { id: "resp-manual" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "compaction", id: "cmp_first" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "compaction", id: "cmp_first", encrypted_content: "CIPHER-FIRST" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", delta: "throwaway continuation" },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", content: [] } },
    { type: "response.output_item.added", output_index: 2, item: { type: "compaction", id: "cmp_last" } },
    { type: "response.output_item.done", output_index: 2, item: { type: "compaction", id: "cmp_last", encrypted_content: "CIPHER-LAST" } },
    {
      type: "response.completed",
      response: {
        id: "resp-manual",
        output: [],
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    },
  ];
  return [...lines.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n");
}

test("serverCompactionManualRequest forces the threshold and omits the trigger item", () => {
  const model = serverModel();
  const body = serverCompactionManualRequest({
    model,
    messages: [{ role: "user", content: "fold me", timestamp: 1 }] as any,
    instructions: "system",
    promptCacheKey: "session-test",
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.context_management, [
    { type: "compaction", compact_threshold: 1_000 },
  ]);
  assert.notEqual(body.input.at(-1)?.type, "compaction_trigger");
  assert.equal(body.input.at(-1)?.role, "user");
  assert.equal(body.prompt_cache_key, "session-test");
});

test("buildCompactRequest still appends the Codex trigger by default", () => {
  const body = buildCompactRequest({
    model: serverModel(),
    messages: [{ role: "user", content: "fold me", timestamp: 1 }] as any,
    instructions: "system",
  });
  assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
  assert.equal(body.context_management, undefined);
});

test("serverCompactionRequestUrl resolves the connection's /responses route", () => {
  assert.equal(serverCompactionRequestUrl(), "https://api.openai.com/v1/responses");
  assert.equal(
    serverCompactionRequestUrl("https://api.openai.com/v1/"),
    "https://api.openai.com/v1/responses",
  );
});

test("buildServerCompactionHeaders carries plain auth, no Codex flags", () => {
  const headers = buildServerCompactionHeaders(
    "tok",
    { "x-model": "m", "x-model-drop": null },
    { "x-auth": "a" },
  );
  assert.equal(headers.get("authorization"), "Bearer tok");
  assert.equal(headers.get("x-model"), "m");
  assert.equal(headers.get("x-auth"), "a");
  assert.equal(headers.has("x-model-drop"), false);
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.has("chatgpt-account-id"), false);
  assert.equal(headers.has("x-codex-beta-features"), false);
  assert.equal(headers.has("originator"), false);
});

test("parseServerCompactionManualResponse takes the last compaction item", () => {
  const parsed = parseServerCompactionManualResponse(manualSse());
  assert.equal(parsed.item.encrypted_content, "CIPHER-LAST");
  assert.equal(parsed.responseId, "resp-manual");
  assert.equal(parsed.tokenUsage?.input_tokens, 120);
});

test("parseServerCompactionManualResponse rejects a stream with no compaction item", () => {
  const noItem = manualSse()
    .split("\n")
    .filter((line) => !line.includes("compaction"))
    .join("\n");
  assert.throws(() => parseServerCompactionManualResponse(noItem), /no compaction item/);
});

test("parseServerCompactionManualResponse rejects a stream that never completed", () => {
  const truncated = manualSse()
    .split("\n")
    .filter((line) => !line.includes("response.completed"))
    .join("\n");
  assert.throws(() => parseServerCompactionManualResponse(truncated), /response\.completed/);
});

test("parseServerCompactionManualResponse surfaces a server-side failure", () => {
  const failed = [
    { type: "response.created", response: { id: "resp-fail" } },
    {
      type: "response.failed",
      response: { id: "resp-fail", error: { code: "server_error", message: "model overloaded" } },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n");
  assert.throws(() => parseServerCompactionManualResponse(failed), /model overloaded/);
});

test("parseServerCompactionManualResponse names an incomplete ending", () => {
  const incomplete = [
    { type: "response.created", response: { id: "resp-inc" } },
    { type: "response.incomplete", response: { id: "resp-inc", incomplete_details: { reason: "max_output_tokens" } } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n");
  assert.throws(() => parseServerCompactionManualResponse(incomplete), /ended incomplete/);
});

function manualPreparation(overrides: Record<string, unknown> = {}): any {
  return {
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [{ role: "user", content: "old context", timestamp: 1 }],
    turnPrefixMessages: [],
    tokensBefore: 100_000,
    previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 },
    ...overrides,
  };
}

async function callManualCompaction(
  handlers: Map<string, Handler>,
  ctx: any,
  overrides: {
    preparation?: Record<string, unknown>;
    event?: Record<string, unknown>;
  } = {},
): Promise<any> {
  return handlers.get("session_before_compact")?.(
    {
      preparation: manualPreparation(overrides.preparation ?? {}),
      branchEntries: [],
      customInstructions: undefined,
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
      ...(overrides.event ?? {}),
    },
    ctx,
  );
}

function stubFetch(capture: { url?: string; init?: RequestInit }, respond: () => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    capture.url = String(input);
    capture.init = init;
    return respond();
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("manual /compact folds server-side through a forced-threshold request", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  const capture: { url?: string; init?: RequestInit } = {};
  const restore = stubFetch(capture, () =>
    new Response(manualSse(), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const result = await callManualCompaction(handlers, ctx);
    assert.equal(capture.url, "https://api.openai.com/v1/responses");
    const headers = new Headers(capture.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key");
    assert.equal(headers.has("x-codex-beta-features"), false);
    const body = JSON.parse(String(capture.init?.body));
    assert.equal(body.model, "gpt-6-sol");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.context_management, [
      { type: "compaction", compact_threshold: 1_000 },
    ]);
    assert.notEqual(body.input.at(-1)?.type, "compaction_trigger");
    assert.equal(body.input.at(-1).role, "user");
    assert.equal(body.input.at(-1).content[0].text, "old context");
    assert.equal(body.prompt_cache_key, "session-test");
    assert.equal(body.instructions, "system");

    const compaction = result.compaction;
    assert.match(compaction.summary, /^\[pi-codex server compaction /);
    assert.equal(compaction.firstKeptEntryId, "kept-entry");
    assert.equal(compaction.tokensBefore, 100_000);
    assert.equal(compaction.details.type, SERVER_COMPACTION_KIND);
    assert.equal(compaction.details.version, SERVER_COMPACTION_VERSION);
    assert.equal(compaction.details.item.encrypted_content, "CIPHER-LAST");
    assert.equal(compaction.details.modelId, "gpt-6-sol");
    assert.equal(compaction.usage.input, 90);
    assert.equal(compaction.usage.output, 30);
    assert.equal(compaction.usage.cacheRead, 20);
    assert.equal(compaction.usage.cacheWrite, 10);
    assert.equal(compaction.usage.reasoning, 12);
  } finally {
    restore();
  }
});

test("manual fold chains an existing server checkpoint into the request", async () => {
  const { handlers } = createHarness();
  const previous = detailsFor("cp-prev", { type: "compaction", id: "cmp_prev", encrypted_content: "PREV-CIPHER" });
  const { ctx } = createContext(serverModel(), {
    branch: [{ type: "compaction", id: "c1", details: previous }],
  });
  const capture: { url?: string; init?: RequestInit } = {};
  const restore = stubFetch(capture, () =>
    new Response(manualSse(), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const result = await callManualCompaction(handlers, ctx, {
      preparation: { previousSummary: serverCompactionMarker("cp-prev") },
    });
    const body = JSON.parse(String(capture.init?.body));
    assert.deepEqual(body.input[0], previous.item);
    // Replace mode: the marker text is not a message — the item replaces it.
    assert.equal(
      body.input.some((item: any) =>
        JSON.stringify(item).includes("Previous compaction summary")),
      false,
    );
    assert.equal(result.compaction.details.modelId, "gpt-6-sol");
  } finally {
    restore();
  }
});

test("manual fold carries a prior local summary when no checkpoint exists", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  const capture: { init?: RequestInit } = {};
  const restore = stubFetch(capture, () =>
    new Response(manualSse(), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    await callManualCompaction(handlers, ctx, {
      preparation: { previousSummary: "goal: ship the fold" },
    });
    const body = JSON.parse(String(capture.init?.body));
    assert.equal(body.input[0].type, "message");
    assert.match(body.input[0].content[0].text, /Previous compaction summary:\ngoal: ship the fold/);
  } finally {
    restore();
  }
});

test("manual fold chains an older server checkpoint under a newer local summary", async () => {
  const { handlers } = createHarness();
  const previous = detailsFor("cp-old", { type: "compaction", id: "cmp_old", encrypted_content: "OLD-CIPHER" });
  // Newest boundary is a LOCAL compaction; the server checkpoint is older —
  // prepend mode. The fold must send BOTH, opaque item first.
  const { ctx } = createContext(serverModel(), {
    branch: [
      { type: "compaction", id: "srv-1", details: previous },
      { type: "compaction", id: "local-1", summary: "local fold summary" },
    ],
  });
  const capture: { init?: RequestInit } = {};
  const restore = stubFetch(capture, () =>
    new Response(manualSse(), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const result = await callManualCompaction(handlers, ctx, {
      preparation: { previousSummary: "local fold summary" },
    });
    const body = JSON.parse(String(capture.init?.body));
    assert.deepEqual(body.input[0], previous.item);
    assert.equal(body.input[1].type, "message");
    assert.match(
      body.input[1].content[0].text,
      /Previous compaction summary:\nlocal fold summary/,
    );
    assert.equal(result.compaction.details.item.encrypted_content, "CIPHER-LAST");
  } finally {
    restore();
  }
});

test("manual fold declines a proxied connection and keeps the local path", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel(), { providerBaseUrl: "https://proxy.test/v1" });
  const restore = stubFetch({}, () => {
    throw new Error("fetch must not run on a proxied connection");
  });
  try {
    const result = await callManualCompaction(handlers, ctx);
    assert.equal(result, undefined);
  } finally {
    restore();
  }
});

test("manual fold declines an empty span and non-openai models without fetching", async () => {
  const { handlers } = createHarness();
  const anthropic = {
    id: "claude-opus-4",
    provider: "anthropic",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200_000,
  };
  const calls: string[] = [];
  const restore = stubFetch({}, () => {
    calls.push("fetch");
    throw new Error("must not fetch");
  });
  try {
    const serverContext = createContext(serverModel());
    const empty = await callManualCompaction(handlers, serverContext.ctx, {
      preparation: { messagesToSummarize: [], turnPrefixMessages: [] },
    });
    assert.equal(empty, undefined);
    const other = await callManualCompaction(handlers, createContext(anthropic as any).ctx);
    assert.equal(other, undefined);
    const threshold = await callManualCompaction(handlers, serverContext.ctx, {
      event: { reason: "threshold" },
    });
    assert.equal(threshold, undefined);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test("manual fold surfaces an auth failure instead of silently going local", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel(), { authError: "no openai auth" });
  const restore = stubFetch({}, () => {
    throw new Error("must not fetch");
  });
  try {
    await assert.rejects(
      () => callManualCompaction(handlers, ctx),
      /no openai auth/,
    );
  } finally {
    restore();
  }
});

test("manual fold reports a failing fold request", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  // 429 + retry-after-ms: 0 keeps fetchRemoteCompaction's retries instant.
  const restore = stubFetch({}, () =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after-ms": "0" },
    }));
  try {
    await assert.rejects(
      () => callManualCompaction(handlers, ctx),
      /OpenAI server compaction failed \(429\)/,
    );
  } finally {
    restore();
  }
});

// ── Compaction usage is priced like a streamed response ──
//
// Pi totals `entry.usage.cost` as stored (getSessionStats, the cost
// breakdown); pi-ai prices every streamed assistant message with
// calculateCost. A compaction entry carrying a zero cost silently drops the
// compaction request — often the largest input of the session — from the
// session cost.

import { toPiUsage } from "../src/remote-compaction.ts";

const responsesUsage = {
  input_tokens: 120,
  output_tokens: 30,
  total_tokens: 150,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  output_tokens_details: { reasoning_tokens: 12 },
};

test("toPiUsage prices usage with the model's catalog rates", () => {
  const usage = toPiUsage(responsesUsage, {
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 },
  } as any);
  assert.ok(usage);
  assert.ok(Math.abs(usage.cost.input - (90 * 2) / 1e6) < 1e-15);
  assert.ok(Math.abs(usage.cost.output - (30 * 8) / 1e6) < 1e-15);
  assert.ok(Math.abs(usage.cost.cacheRead - (20 * 0.5) / 1e6) < 1e-15);
  assert.ok(Math.abs(usage.cost.cacheWrite - (10 * 2.5) / 1e6) < 1e-15);
  assert.ok(
    Math.abs(usage.cost.total - (90 * 2 + 30 * 8 + 20 * 0.5 + 10 * 2.5) / 1e6) < 1e-15,
  );
});

test("toPiUsage applies the catalog's long-context pricing tier", () => {
  const usage = toPiUsage(
    { input_tokens: 300_000, output_tokens: 10 },
    {
      cost: {
        input: 4,
        output: 20,
        cacheRead: 0.4,
        cacheWrite: 5,
        tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
      },
    } as any,
  );
  assert.ok(usage);
  assert.ok(Math.abs(usage.cost.total - (300_000 * 8 + 10 * 30) / 1e6) < 1e-12);
});

test("toPiUsage keeps a zero cost when the model has no numeric rates", () => {
  for (const model of [undefined, {}, { cost: undefined }, { cost: { input: 1 } }]) {
    const usage = toPiUsage(responsesUsage, model as any);
    assert.ok(usage);
    assert.deepEqual(usage.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
    assert.equal(Number.isNaN(usage.cost.total), false);
  }
});

test("manual server fold records the fold request's cost on the compaction entry", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(
    serverModel({ cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 } }),
  );
  const restore = stubFetch({}, () =>
    new Response(manualSse(), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const result = await callManualCompaction(handlers, ctx);
    // manualSse() reports the same usage as responsesUsage above.
    const expected = (90 * 2 + 30 * 8 + 20 * 0.5 + 10 * 2.5) / 1e6;
    assert.ok(
      Math.abs(result.compaction.usage.cost.total - expected) < 1e-15,
      `expected ${expected}, got ${result.compaction.usage.cost.total}`,
    );
  } finally {
    restore();
  }
});

// ── Overlapping streams: a warming replay opened mid-foreground ──
//
// pi's CacheWarmer.refresh replays the request with the original
// onPayload/onProviderStreamEvent callbacks during the streaming phase, so a
// warming stream can open while the foreground one is still running. Output
// events carry no response id, and response.completed may arrive with an
// empty output array on this connection (2026-10-29 probe), so the slot's
// item is the only evidence — and after the warming response.created it
// belongs to the warming stream.

test("a completion cannot claim a slot opened by another response", () => {
  const warming = { type: "compaction", id: "cmp_warm", encrypted_content: "warm" };
  let capture = updateServerCompactionCapture(undefined, {
    type: "response.created",
    response: { id: "resp_fg" },
  });
  assert.equal(capture?.createdResponseId, "resp_fg");
  capture = updateServerCompactionCapture(capture, {
    type: "response.created",
    response: { id: "resp_warm" },
  });
  capture = updateServerCompactionCapture(capture, {
    type: "response.output_item.done",
    output_index: 0,
    item: warming,
  });
  const foreground = updateServerCompactionCapture(capture, {
    type: "response.completed",
    response: { id: "resp_fg", output: [], usage: { input_tokens: 10 } },
  });
  assert.equal(foreground?.responseId, "resp_fg");
  assert.equal(foreground?.item, undefined, "the warming item must not become resp_fg's");
  assert.equal(foreground?.contentCountBefore, undefined);

  // The owning stream still folds its own slot item.
  const own = updateServerCompactionCapture(capture, {
    type: "response.completed",
    response: { id: "resp_warm", output: [] },
  });
  assert.equal(own?.item?.id, "cmp_warm");

  // A completion without an id cannot be compared and keeps the legacy fold.
  const legacy = updateServerCompactionCapture(capture, {
    type: "response.completed",
    response: { output: [], usage: { input_tokens: 10 } },
  });
  assert.equal(legacy?.item?.id, "cmp_warm");
});

test("turn_end never commits a warming response's checkpoint for the foreground", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext(serverModel());
  await handlers.get("session_start")?.({}, ctx);
  const request = handlers.get("before_provider_request")!;
  const stream = (data: any) =>
    handlers.get("provider_stream_event")?.({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-6-sol",
      data,
    });
  const foreground = { type: "compaction", id: "cmp_fg", encrypted_content: "fg" };
  const warming = { type: "compaction", id: "cmp_warm", encrypted_content: "warm" };
  const usage = { input_tokens: 250_000, output_tokens: 10 };

  handlers.get("turn_start")?.({ turnIndex: 0, timestamp: 1 });
  await request({ payload: { input: [] } }, ctx);
  stream({ type: "response.created", response: { id: "resp_fg" } });
  stream({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } });
  stream({ type: "response.output_item.done", output_index: 1, item: foreground });
  // The warmer's timer fires while the foreground is still generating.
  await request({ payload: { input: [] } }, ctx);
  stream({ type: "response.created", response: { id: "resp_warm" } });
  stream({ type: "response.output_item.added", output_index: 2, item: { type: "message" } });
  stream({ type: "response.output_item.done", output_index: 0, item: warming });
  stream({ type: "response.completed", response: { id: "resp_fg", output: [], usage } });
  stream({ type: "response.completed", response: { id: "resp_warm", output: [], usage } });

  const result = handlers.get("turn_end")?.(
    {
      entries: [],
      messageEntryId: "assistant-fg",
      message: {
        role: "assistant",
        responseId: "resp_fg",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "t" },
          { type: "text", text: "after the checkpoint" },
        ],
      },
      toolResults: [],
    },
    ctx,
  );
  const entries = result?.entries ?? [];
  const compaction = entries.find((entry: any) => entry.type === "compaction");
  assert.notEqual(
    compaction?.details.item.id,
    "cmp_warm",
    "the warming response's item was committed as the foreground checkpoint",
  );
  // The foreground item is unattributable once the streams overlap and the
  // completion carries no output list: leave it uncommitted rather than
  // guessing, and leave the assistant message untouched.
  assert.equal(compaction, undefined);
  assert.equal(entries.some((entry: any) => entry.type === "context_edit"), false);
});
