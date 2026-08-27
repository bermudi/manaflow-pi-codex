import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  CompactionSummaryMessageComponent,
  initTheme,
  SettingsManager,
  shouldCompact,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import piCodex, {
  applyPatchBullet,
  applyPatchCallHeader,
  applyPatchGrammar,
  changedPathsFromOutput,
  CODEX_FAST_SERVICE_TIER,
  CODEX_SOL_AUTO_COMPACT_LIMIT,
  CODEX_SOL_CONTEXT_WINDOW,
  CODEX_SOL_RESERVE_TOKENS,
  codexAutoCompactLimit,
  displayPath,
  formatWorkingElapsed,
  installCompactCompactionRenderer,
  isCodexModel,
  patchDisplayPaths,
  pathsFromPatch,
  supportsCodexFastMode,
} from "../extensions/pi-codex.ts";
import {
  CODEX_APPLY_PATCH_FLAG,
  resolveCodexExecutable,
} from "../src/codex-binary.ts";
import {
  buildReplacementHistory,
  buildCompactRequest,
  checkpointMarker,
  fingerprintCheckpointInput,
  fingerprintCheckpointSuffix,
  installRemoteCheckpoint,
  isRemoteCompactionDetails,
  parseRemoteCompactionSse,
  resolveCompactUrl,
} from "../src/remote-compaction.ts";
import {
  CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  formatCodexTruncatedOutput,
  resolveCodexTruncationPolicy,
  truncateCodexText,
  truncateCodexOutput,
} from "../src/output-truncation.ts";
import {
  ToolContractRegistry,
  createToolContract,
  fingerprintToolCatalog,
} from "../src/tool-contract.ts";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  buildWebSearchHeaders,
  resolveWebSearchUrl,
  summarizeWebSearchCommands,
} from "../src/web-search.ts";
import { CLEAN_TUI_ACTIVE } from "../src/clean-burst.ts";

function run(executable: string, args: string[], cwd: string, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

function renderTheme() {
  return {
    bold: (text: string) => text,
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
  };
}

function renderCtx(toolCallId: string, expanded = false) {
  return {
    toolCallId,
    expanded,
    isPartial: false,
    isError: false,
    argsComplete: true,
    invalidate: () => {},
  } as any;
}

/** Run fn with the goodies clean-tui integration flag set (burst rendering). */
function withCleanTui(fn: () => void): void {
  const globals = globalThis as Record<symbol, unknown>;
  globals[CLEAN_TUI_ACTIVE] = true;
  try {
    fn();
  } finally {
    delete globals[CLEAN_TUI_ACTIVE];
  }
}

test("uses the upstream freeform apply_patch grammar", () => {
  assert.match(applyPatchGrammar, /^start: begin_patch hunk\+ end_patch/m);
  assert.match(applyPatchGrammar, /update_hunk:.*change_move\? change\?/);
  assert.match(applyPatchGrammar, /eof_line: "\*\*\* End of File" LF/);
});

test("pi-codex loads when Pi starts outside the package directory", async () => {
  const projectRoot = join(import.meta.dirname, "..");
  const result = await run(
    process.execPath,
    [
      join(
        projectRoot,
        "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--extension",
      join(projectRoot, "extensions/pi-codex.ts"),
      "--offline",
    ],
    tmpdir(),
    `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"command":"get_state","success":true/);
});

test("recognizes Codex models", () => {
  assert.equal(isCodexModel({ provider: "openai-codex", id: "gpt-5.6-sol" } as never), true);
  assert.equal(isCodexModel({ provider: "openai", id: "gpt-5.3-codex" } as never), true);
  assert.equal(
    isCodexModel({
      provider: "subrouter",
      id: "gpt-5.6-sol",
      api: "openai-codex-responses",
    } as never),
    true,
  );
  assert.equal(isCodexModel({ provider: "openai", id: "gpt-5.4" } as never), false);
  assert.equal(
    isCodexModel({ provider: "openrouter", id: "deepseek/deepseek-v4-flash-free" } as never),
    true,
  );
  assert.equal(isCodexModel({ provider: "openrouter", id: "deepseek-v4-pro" } as never), true);
  assert.equal(isCodexModel({ provider: "openrouter", id: "deepseek-v4" } as never), true);
  assert.equal(isCodexModel({ provider: "openrouter", id: "deepseek-v4.5" } as never), false);
  assert.equal(isCodexModel({ provider: "openrouter", id: "deepseek-v3-r1" } as never), false);
  assert.equal(
    supportsCodexFastMode({ provider: "openai-codex", id: "gpt-5.6-sol" } as never),
    true,
  );
  assert.equal(
    supportsCodexFastMode({ provider: "openai-codex", id: "gpt-5.4-mini" } as never),
    false,
  );
  assert.equal(
    supportsCodexFastMode({ provider: "openrouter", id: "openai/gpt-5.6-sol" } as never),
    false,
  );
});

test("resolves Codex standalone web search through provider base URLs", () => {
  assert.equal(
    resolveWebSearchUrl("http://subrouter.test/backend-api"),
    "http://subrouter.test/backend-api/codex/alpha/search",
  );
  assert.equal(
    resolveWebSearchUrl("https://chatgpt.com/backend-api/codex"),
    "https://chatgpt.com/backend-api/codex/alpha/search",
  );
  assert.equal(
    summarizeWebSearchCommands({ search_query: [{ q: "OpenAI Codex" }] }),
    "OpenAI Codex",
  );

  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_search" },
  })).toString("base64url");
  const headers = buildWebSearchHeaders(
    `e30.${tokenPayload}.signature`,
    { "X-Subrouter-Agent": "pi" },
    { "X-Subrouter-Session": "search-session" },
  );
  assert.equal(headers.get("x-subrouter-agent"), "pi");
  assert.equal(headers.get("x-subrouter-session"), "search-session");
  assert.equal(headers.get("chatgpt-account-id"), "acct_search");
});

test("standalone web search executes through the subrouter and renders as a Pi tool", async () => {
  const tools = new Map<string, any>();
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    getActiveTools: () => ["web_search", "apply_patch"],
    getAllTools: () => [...tools.values()],
    setActiveTools() {},
    on() {},
  } as unknown as ExtensionAPI;
  piCodex(pi);

  const webSearch = tools.get("web_search");
  assert.ok(webSearch);
  const renderedCall = webSearch.renderCall(
    { search_query: [{ q: "OpenAI Codex" }] },
    renderTheme(),
  );
  assert.match(renderedCall.render(120).join("\n"), /web_search OpenAI Codex/);

  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_render" },
  })).toString("base64url");
  const token = `e30.${tokenPayload}.signature`;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      output: "Search result with source https://example.com",
      results: [{ url: "https://example.com" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const model = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      headers: { "X-Subrouter-Agent": "pi" },
    };
    const result = await webSearch.execute(
      "search-1",
      { search_query: [{ q: "OpenAI Codex" }], response_length: "short" },
      new AbortController().signal,
      undefined,
      {
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: token,
            headers: { "X-Subrouter-Session": "render-test" },
          }),
          getProviderAuth: async () => ({
            auth: { baseUrl: "http://subrouter.test/backend-api" },
          }),
        },
        sessionManager: {
          getSessionId: () => "session-render",
          getBranch: () => [{
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Search the web" }] },
          }],
        },
      },
    );
    assert.equal(
      requestedUrl,
      "http://subrouter.test/backend-api/codex/alpha/search",
    );
    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get("x-subrouter-agent"), "pi");
    assert.equal(headers.get("x-subrouter-session"), "render-test");
    const body = JSON.parse(String(requestedInit?.body));
    assert.deepEqual(body.commands.search_query, [{ q: "OpenAI Codex" }]);
    assert.equal(result.details.endpoint, requestedUrl);

    // Burst rendering (clean-tui active): the collapsed call hides the output;
    // after renderResult records the result, an expanded renderCall shows the
    // raw output.
    withCleanTui(() => {
      const rowCtx = renderCtx("search-1");
      const collapsed = webSearch.renderCall(
        { search_query: [{ q: "OpenAI Codex" }], response_length: "short" },
        renderTheme(),
        rowCtx,
      );
      webSearch.renderResult(
        result,
        { expanded: false, isPartial: false },
        renderTheme(),
        rowCtx,
      );
      const collapsedText = stripVTControlCharacters(collapsed.render(120).join("\n"));
      assert.doesNotMatch(collapsedText, /Search result with source/);
      rowCtx.expanded = true;
      const expanded = webSearch.renderCall(
        { search_query: [{ q: "OpenAI Codex" }], response_length: "short" },
        renderTheme(),
        rowCtx,
      );
      assert.match(
        stripVTControlCharacters(expanded.render(120).join("\n")),
        /Search result with source https:\/\/example\.com/,
      );
    });

    // Default rendering (no clean-tui): the output stays visible, collapsed
    // to 2000 chars; expansion shows the raw output.
    const defaultCtx = renderCtx("search-default");
    webSearch.renderCall(
      { search_query: [{ q: "OpenAI Codex" }], response_length: "short" },
      renderTheme(),
      defaultCtx,
    );
    const defaultCollapsed = webSearch.renderResult(
      result,
      { expanded: false, isPartial: false },
      renderTheme(),
      defaultCtx,
    );
    const defaultText = stripVTControlCharacters(defaultCollapsed.render(120).join("\n"));
    assert.match(defaultText, /Search result with source https:\/\/example\.com/);
    const oversizedSample = {
      content: [{ type: "text", text: "x".repeat(2_500) }],
      details: { rawOutput: "raw search output" },
    };
    const truncated = webSearch.renderResult(
      oversizedSample,
      { expanded: false, isPartial: false },
      renderTheme(),
      defaultCtx,
    );
    const truncatedText = stripVTControlCharacters(truncated.render(120).join("\n"));
    assert.match(truncatedText, /…/);
    assert.doesNotMatch(truncatedText, /raw search output/);
    defaultCtx.expanded = true;
    const defaultExpanded = webSearch.renderResult(
      oversizedSample,
      { expanded: true, isPartial: false },
      renderTheme(),
      defaultCtx,
    );
    assert.match(
      stripVTControlCharacters(defaultExpanded.render(120).join("\n")),
      /raw search output/,
    );

    const oversized = "x".repeat(60_000);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ output: oversized }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const oversizedResult = await webSearch.execute(
      "search-2",
      { search_query: [{ q: "large result" }] },
      new AbortController().signal,
      undefined,
      {
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
          getProviderAuth: async () => ({
            auth: { baseUrl: "http://subrouter.test/backend-api" },
          }),
        },
        sessionManager: {
          getSessionId: () => "session-render",
          getBranch: () => [],
        },
      },
    );
    assert.ok(
      Buffer.byteLength(oversizedResult.details.rawOutput, "utf8") <= 50_000,
      "persisted inspection output stays bounded",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extracts changed paths from Codex output", () => {
  assert.deepEqual(
    changedPathsFromOutput("Success. Updated the following files:\nA one.txt\nM src/two.ts\nD old.txt\n"),
    ["one.txt", "src/two.ts", "old.txt"],
  );
});

test("extracts all source and destination paths from an apply patch", () => {
  assert.deepEqual(
    pathsFromPatch(
      "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** Add File: added.ts\n+added\n*** End Patch",
    ),
    ["old.ts", "new.ts", "added.ts"],
  );
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("patch paths display relative to cwd, ~ under home, absolute elsewhere", () => {
  const cwd = `${homedir()}/Desktop/Clients/recam-laser-international`;
  const patch = (files: string[]) =>
    `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}`).join("\n")}\n*** End Patch`;
  assert.deepEqual(
    patchDisplayPaths(patch([`${cwd}/README.md`, "docs/new.md"]), cwd),
    ["README.md", "docs/new.md"],
  );
  assert.deepEqual(
    patchDisplayPaths(patch([`${homedir()}/notes.md`]), cwd),
    ["~/notes.md"],
  );
  assert.deepEqual(patchDisplayPaths(patch(["/etc/hosts"]), cwd), ["/etc/hosts"]);
  assert.deepEqual(patchDisplayPaths(patch(["/etc/hosts"]), undefined), ["/etc/hosts"]);
  assert.deepEqual(patchDisplayPaths(patch(["docs/new.md"]), `${cwd}/`), ["docs/new.md"]);
  assert.equal(displayPath(".", cwd), ".");
});

test("burst bullets put each patched file on its own aligned line", () => {
  const patch =
    "*** Begin Patch\n*** Update File: a.md\n@@\n*** Update File: b.md\n@@\n*** End Patch";
  assert.equal(
    applyPatchBullet({ args: { patch }, isError: false }, plainTheme, "/cwd"),
    "  • a.md\n    b.md",
  );
  assert.equal(
    applyPatchBullet({ args: { patch: "" }, isError: true }, plainTheme, "/cwd"),
    "  • patch",
  );
});

test("call headers keep a single file inline and nest multi-file lists", () => {
  const title = "apply_patch";
  assert.equal(
    applyPatchCallHeader("*** Begin Patch\n*** Update File: a.md\n*** End Patch", title, plainTheme, "/cwd"),
    "apply_patch a.md",
  );
  const multi = "*** Begin Patch\n*** Update File: a.md\n*** Update File: b.md\n*** End Patch";
  assert.equal(
    applyPatchCallHeader(multi, title, plainTheme, "/cwd"),
    "apply_patch\n  a.md\n  b.md",
  );
});

test("path cap boundary: eight paths show no tail, nine do", () => {
  const patch = (n: number) =>
    `*** Begin Patch\n${Array.from({ length: n }, (_, i) => `*** Update File: f${i}.md`).join("\n")}\n*** End Patch`;
  const eight = applyPatchCallHeader(patch(8), "apply_patch", plainTheme, "/cwd").split("\n");
  assert.equal(eight.length, 9);
  assert.equal(eight.at(-1), "  f7.md");
  const nine = applyPatchCallHeader(patch(9), "apply_patch", plainTheme, "/cwd").split("\n");
  assert.equal(nine.length, 9);
  assert.equal(nine.at(-1), "  … +2 more");
});

test("path lists cap at eight lines with a muted tail", () => {
  const files = Array.from({ length: 12 }, (_, i) => `f${i}.md`);
  const patch = `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}`).join("\n")}\n*** End Patch`;
  const headerLines = applyPatchCallHeader(patch, "apply_patch", plainTheme, "/cwd").split("\n");
  assert.equal(headerLines.length, 9);
  assert.equal(headerLines.at(-1), "  … +5 more");
  const bulletLines = applyPatchBullet({ args: { patch }, isError: false }, plainTheme, "/cwd").split("\n");
  assert.equal(bulletLines.length, 8);
  assert.equal(bulletLines.at(-1), "    … +5 more");
});

test("renders collapsed compaction status on one content line", () => {
  initTheme(undefined, false);
  installCompactCompactionRenderer();
  const component = new CompactionSummaryMessageComponent({
    role: "compactionSummary",
    summary: "opaque summary",
    tokensBefore: 244_800,
    timestamp: Date.now(),
  });
  assert.equal(component.render(100).length, 1);
  assert.match(component.render(100)[0], /\[compaction\].*Compacted from 244,800 tokens/);
});

test("apply_patch captures display-oriented diffs from actual file changes", async () => {
  let tool: any;
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tool = definition;
    },
    appendEntry() {},
    getActiveTools: () => [],
    setActiveTools() {},
    on() {},
    exec: (command: string, args: string[], options: { cwd: string }) =>
      run(command, args, options.cwd),
  } as unknown as ExtensionAPI;
  piCodex(pi);

  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-render-test-"));
  try {
    await writeFile(join(cwd, "hello.txt"), "hello\n");
    const result = await tool.execute(
      "call-1",
      {
        patch:
          "*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+hello colored diff\n*** End Patch",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.deepEqual(result.details.changedPaths, ["hello.txt"]);
    assert.equal(result.details.diffs.length, 1);
    assert.equal(result.details.diffs[0].path, "hello.txt");
    assert.match(result.details.diffs[0].diff, /-1 hello/);
    assert.match(result.details.diffs[0].diff, /\+1 hello colored diff/);
    initTheme(undefined, false);
    const patch =
      "*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+hello colored diff\n*** End Patch";
    // Burst rendering (clean-tui active): collapsed header shows the touched
    // paths only; the diff appears once the row is expanded.
    withCleanTui(() => {
      const theme = renderTheme();
      const rowCtx = renderCtx("call-1");
      const collapsed = tool.renderCall({ patch }, theme, rowCtx);
      tool.renderResult(result, { expanded: false, isPartial: false }, theme, rowCtx);
      const collapsedText = stripVTControlCharacters(collapsed.render(120).join("\n"));
      assert.match(collapsedText, /apply_patch hello\.txt/);
      assert.doesNotMatch(collapsedText, /hello colored diff/);
      rowCtx.expanded = true;
      const rendered = tool.renderCall({ patch }, theme, rowCtx);
      const renderedText = rendered.render(120).join("\n");
      assert.match(stripVTControlCharacters(renderedText), /hello colored diff/);
      assert.match(renderedText, /\u001b\[/);
    });

    // Default rendering (no clean-tui): edit-like — the diff stays visible
    // in the result row without expansion.
    const defaultTheme = renderTheme();
    const defaultCtx = renderCtx("call-default");
    const defaultCall = tool.renderCall({ patch }, defaultTheme, defaultCtx);
    assert.match(
      stripVTControlCharacters(defaultCall.render(120).join("\n")),
      /apply_patch hello\.txt/,
    );
    const defaultRendered = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      defaultTheme,
      defaultCtx,
    );
    const defaultText = defaultRendered.render(120).join("\n");
    assert.match(stripVTControlCharacters(defaultText), /hello colored diff/);
    assert.match(defaultText, /\u001b\[/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("swaps write tools only while a Codex model is selected", async () => {
  let active = ["read", "bash", "edit", "write"];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, any>();
  const fastEntries: any[] = [];
  let toolDefinition: any;
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    appendEntry(customType: string, data: unknown) {
      fastEntries.push({ type: "custom", customType, data });
    },
    registerTool(definition: any) {
      toolDefinition = definition;
      active.push(definition.name);
    },
    getActiveTools: () => active,
    setActiveTools(tools: string[]) {
      active = tools;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  piCodex(pi);
  const settings = SettingsManager.inMemory();
  assert.equal(toolDefinition.constrainedSampling.type, "grammar");
  assert.deepEqual(toolDefinition.parameters.required, ["patch"]);
  assert.match(toolDefinition.promptGuidelines.join("\n"), /re-read the affected region/);
  const multipartResult: any = handlers.get("tool_result")?.(
    {
      toolName: "bash",
      content: [
        { type: "text", text: "HEAD-" + "x".repeat(20_000) },
        { type: "image", data: "image", mimeType: "image/png" },
        { type: "text", text: "-TAIL" },
      ],
      details: { raw: true },
      isError: false,
    },
    { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
  );
  assert.equal(multipartResult.content.length, 3);
  assert.equal(multipartResult.content[0].type, "text");
  assert.match(multipartResult.content[0].text, /HEAD-/);
  assert.equal(multipartResult.content[1].type, "image");
  assert.equal(multipartResult.content[2].type, "text");
  assert.match(multipartResult.content[2].text, /-TAIL/);
  assert.deepEqual(multipartResult.details, { raw: true });
  const manyTextItems: any = handlers.get("tool_result")?.(
    {
      toolName: "bash",
      content: Array.from({ length: 20_000 }, () => ({
        type: "text",
        text: "x",
      })),
      details: undefined,
      isError: false,
    },
    { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
  );
  assert.ok(manyTextItems.content.length <= 10_000);

  await handlers.get("session_start")?.({}, {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: false,
  });
  assert.deepEqual(active, ["read", "bash", "web_search", "apply_patch"]);
  assert.equal(CODEX_SOL_CONTEXT_WINDOW, 272_000);
  assert.equal(CODEX_SOL_AUTO_COMPACT_LIMIT, 244_800);
  assert.equal(settings.getCompactionSettings().reserveTokens, CODEX_SOL_RESERVE_TOKENS);
  assert.equal(
    shouldCompact(244_799, CODEX_SOL_CONTEXT_WINDOW, settings.getCompactionSettings()),
    false,
  );
  assert.equal(
    shouldCompact(244_800, CODEX_SOL_CONTEXT_WINDOW, settings.getCompactionSettings()),
    true,
  );
  let workingIndicator: { frames: string[]; intervalMs?: number } | undefined;
  await handlers.get("session_start")?.({}, {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: true,
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setStatus() {},
      setWorkingIndicator(indicator: { frames: string[]; intervalMs?: number }) {
        workingIndicator = indicator;
      },
    },
  });
  assert.equal(workingIndicator, undefined);
  const notices: string[] = [];
  const fastCtx = {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: true,
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setStatus() {},
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  // Fast mode defaults to off: with no saved preference, requests carry no
  // service_tier.
  const defaultFastPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: defaultFastPayload }, fastCtx);
  assert.equal(defaultFastPayload.service_tier, undefined);
  assert.doesNotThrow(() => {
    handlers.get("after_provider_response")?.({ status: 200 }, fastCtx);
  });

  await commands.get("fast").handler("off", fastCtx);
  const disabledFastPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: disabledFastPayload }, fastCtx);
  assert.equal(disabledFastPayload.service_tier, undefined);
  assert.deepEqual(fastEntries.at(-1)?.data, { enabled: false });

  // A saved preference survives a new session start (restoreFastMode).
  await handlers.get("session_start")?.({}, {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: false,
  });
  const restoredOffPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: restoredOffPayload }, fastCtx);
  assert.equal(restoredOffPayload.service_tier, undefined);

  await commands.get("fast").handler("on", fastCtx);
  const enabledFastPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: enabledFastPayload }, fastCtx);
  assert.equal(enabledFastPayload.service_tier, "priority");
  assert.match(notices.at(-1) ?? "", /enabled/);

  await handlers.get("session_start")?.({}, {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: false,
  });
  const restoredOnPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: restoredOnPayload }, fastCtx);
  assert.equal(restoredOnPayload.service_tier, "priority");

  const spark = {
    provider: "openai-codex",
    id: "gpt-5.3-codex-spark",
    contextWindow: 128_000,
  };
  await handlers.get("model_select")?.({ model: spark }, { model: spark, hasUI: false });
  assert.equal(
    shouldCompact(115_199, 128_000, settings.getCompactionSettings()),
    false,
  );
  assert.equal(
    shouldCompact(115_200, 128_000, settings.getCompactionSettings()),
    true,
  );
  assert.equal(codexAutoCompactLimit(128_000), 115_200);

  const anthropic = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    contextWindow: 200_000,
  };
  await handlers.get("model_select")?.(
    { model: anthropic },
    { model: anthropic, hasUI: false },
  );
  assert.deepEqual(active, ["read", "bash", "edit", "write"]);
  assert.equal(settings.getCompactionSettings().reserveTokens, 16_384);
});

test("formats the selection-friendly working ticker", () => {
  assert.equal(formatWorkingElapsed(0), "0s");
  assert.equal(formatWorkingElapsed(59_999), "59s");
  assert.equal(formatWorkingElapsed(65_000), "1m 5s");
  assert.equal(formatWorkingElapsed(3_720_000), "1h 2m");
});

test("resolves the same Responses endpoint as current OpenAI Codex compaction v2", () => {
  assert.equal(
    resolveCompactUrl("https://chatgpt.com/backend-api/codex"),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.equal(
    resolveCompactUrl("https://chatgpt.com/backend-api"),
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("remote compaction requires a provider that declares the capability", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);

  let authRequested = false;
  const result = await handlers.get("session_before_compact")?.({
    preparation: {},
    signal: new AbortController().signal,
  }, {
    model: {
      id: "local-codex",
      provider: "local-responses",
      api: "openai-codex-responses",
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        authRequested = true;
        return { ok: false, error: "remote compaction should not run" };
      },
    },
  });

  assert.equal(result, undefined);
  assert.equal(authRequested, false);
});

test("remote compaction persists and reinstalls Codex replacement history", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => ["read", "bash", "edit", "write", "apply_patch"],
    getAllTools: () => [],
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);

  const accountId = "acct_test";
  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  const token = `e30.${tokenPayload}.signature`;
  const model = {
    id: "gpt-5.6-sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { medium: "medium" },
    compat: { supportsOpenAIGrammarTools: true },
  };
  const replacement = [{ type: "compaction", encrypted_content: "opaque-checkpoint" }];
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: replacement[0] })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-compact",
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-codex-turn-state": "sticky" },
    });
  };

  try {
    const branch: any[] = [];
    branch.push({
      type: "message",
      id: "kept-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "retained tail" }],
        timestamp: 1,
      },
    });
    const ctx = {
      model,
      thinkingLevel: "medium",
      getSystemPrompt: () => "You are Codex.",
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: {} }),
        getProviderAuth: async () => ({
          auth: { baseUrl: "http://subrouter.test/backend-api" },
          source: "test subrouter",
        }),
      },
      sessionManager: {
        getSessionId: () => "session-test",
        getBranch: () => branch,
      },
    };
    const result = await handlers.get("session_before_compact")?.({
      preparation: {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "old context", timestamp: 1 }],
        turnPrefixMessages: [],
        tokensBefore: 100_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      customInstructions: undefined,
      willRetry: true,
      signal: new AbortController().signal,
    }, ctx);

    assert.equal(requestedUrl, "http://subrouter.test/backend-api/codex/responses");
    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get("chatgpt-account-id"), accountId);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("x-codex-beta-features"), "remote_compaction_v2");
    const body = JSON.parse(String(requestedInit?.body));
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.service_tier, undefined);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "You are Codex.");
    assert.equal(body.input[0].role, "user");
    assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });

    const compaction = result.compaction;
    assert.equal(compaction.usage.input, 90);
    assert.equal(compaction.usage.output, 30);
    assert.equal(compaction.usage.cacheRead, 20);
    assert.equal(compaction.usage.cacheWrite, 10);
    assert.equal(compaction.usage.reasoning, 12);
    assert.equal(compaction.details.retainedContextItemCount, 1);
    assert.equal(compaction.details.output.at(-1).encrypted_content, "opaque-checkpoint");
    branch.push({ type: "compaction", details: compaction.details });
    const providerPayload: any = {
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: checkpointMarker(compaction.details.checkpointId),
        }],
      }, {
        role: "user",
        content: [{ type: "input_text", text: "retained tail" }],
      }],
    };
    handlers.get("before_provider_request")?.({ payload: providerPayload }, ctx);
    assert.equal(providerPayload.service_tier, undefined);
    assert.deepEqual(
      providerPayload.input,
      [...compaction.details.output, providerPayload.input.at(-1)],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool contracts preserve TypeBox schemas and Codex exposure metadata", () => {
  const schema = Type.Object({ value: Type.String() });
  const definition: ToolDefinition<typeof schema> = {
    name: "contract_test",
    label: "Contract Test",
    description: "Test tool",
    parameters: schema,
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    },
  };
  const direct = createToolContract(definition, {
    exposure: "direct",
    namespace: "test",
    search: { keywords: ["example"] },
    schemaVersion: "7",
    capabilities: ["test"],
    outputBudgetBytes: 123,
  });
  const deferred = direct.toCodexTool("deferred");
  assert.equal(deferred?.defer_loading, true);
  assert.equal(direct.isDirect(), true);
  assert.equal(direct.isAvailableInCodeMode(), true);
  const modelOnly = createToolContract(definition, {
    exposure: "direct_model_only",
  });
  assert.equal(modelOnly.isDirect(), true);
  assert.equal(modelOnly.isAvailableInCodeMode(), false);
  assert.equal(modelOnly.toCodexTool()?.defer_loading, undefined);
  assert.equal(direct.parameters, definition.parameters);
  assert.equal(direct.snapshot().schemaVersion, "7");
  assert.equal(direct.snapshot().outputBudgetBytes, 123);
  assert.equal(direct.schemaHash.length, 64);
  assert.equal(direct.toCodexTool("hidden"), undefined);

  const registry = new ToolContractRegistry();
  registry.register(definition, { exposure: "deferred" });
  assert.deepEqual(registry.toCodexTools(), []);
  assert.equal(registry.toCodexTools({ includeDeferred: true })[0].defer_loading, true);
  assert.equal(fingerprintToolCatalog(registry.values()), registry.fingerprint());
  assert.throws(
    () => registry.register(definition),
    /already registered/,
  );
});

test("Codex output truncation is model-facing only and preserves both ends", () => {
  const input = `HEAD-${"x".repeat(20_000)}-TAIL`;
  const result = truncateCodexOutput(input);
  assert.equal(CODEX_DEFAULT_OUTPUT_BUDGET_BYTES, 10_000);
  assert.equal(result.truncated, true);
  assert.match(result.content, /Warning: truncated output/);
  assert.match(result.content, /Total output lines: 1/);
  assert.match(result.content, /HEAD-/);
  assert.match(result.content, /-TAIL$/);
  assert.match(result.content, /chars truncated/);
  assert.equal(truncateCodexOutput("short").content, "short");
  assert.equal(
    truncateCodexText("0123456789", { type: "bytes", limit: 4 }),
    "01…6 chars truncated…89",
  );
  assert.match(
    formatCodexTruncatedOutput("a\n", { type: "bytes", limit: 1 }).content,
    /Total output lines: 1/,
  );
  const unicode = truncateCodexOutput("🙂".repeat(20), 10);
  assert.equal(unicode.truncated, true);
  assert.doesNotThrow(() => JSON.stringify(unicode.content));
  assert.deepEqual(
    resolveCodexTruncationPolicy({
      compat: { truncationPolicy: { type: "tokens", limit: 1_000_000 } },
    }),
    { type: "bytes", limit: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES },
    "token policies require a provider tokenizer and must not use byte estimates",
  );
});

test("compaction preserves Codex tool wire modalities and deferred exposure", () => {
  const schema = Type.Object({ query: Type.String() });
  const body = buildCompactRequest({
    model: {
      id: "gpt-5.6-sol",
      compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: false },
      thinkingLevelMap: {},
      input: ["text"],
    } as never,
    messages: [] as never,
    instructions: "system",
    tools: [
      {
        name: "deferred_search",
        description: "Search",
        parameters: schema,
        defer_loading: true,
      },
    ],
  });
  assert.equal((body.tools as any[])[0].type, "function");
  assert.equal((body.tools as any[])[0].defer_loading, true);
  assert.equal((body.tools as any[])[0].strict, null);
});

test("compaction omits legacy function item ids when replaying custom tools", () => {
  const callId = "call_NN4c5V7Onkj6YcXCXgijxyEs";
  const legacyItemId =
    "fc_01656a69efc78cad016a7d50b9d1f4819ba33c01fdfcd6bf52";
  const toolCallId = `${callId}|${legacyItemId}`;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const body = buildCompactRequest({
    model: {
      id: "gpt-5.6-sol",
      provider: "subrouter",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      compat: { supportsOpenAIGrammarTools: true },
    } as never,
    messages: [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: toolCallId,
          name: "apply_patch",
          arguments: { patch: "*** Begin Patch\n*** End Patch" },
        }],
        api: "openai-codex-responses",
        provider: "subrouter",
        model: "gpt-5.5",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "apply_patch",
        content: [{ type: "text", text: "Done" }],
        isError: false,
        timestamp: 2,
      },
    ] as never,
    instructions: "system",
  });

  const customCall = body.input.find(
    (item) => item.type === "custom_tool_call",
  );
  assert.ok(customCall);
  assert.equal("id" in customCall, false);
  assert.equal(customCall.call_id, callId);
  assert.ok(body.input.some(
    (item) =>
      item.type === "custom_tool_call_output" &&
      item.call_id === callId,
  ));
});

test("replacement history retains bounded assistant and oversized text messages", () => {
  const compacted = { type: "compaction", encrypted_content: "opaque" };
  const assistant = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "intermediate answer" }],
  };
  assert.deepEqual(
    buildReplacementHistory(
      [assistant, { type: "compaction_trigger" }],
      compacted,
    ),
    [assistant, compacted],
  );

  const oversized = {
    type: "message",
    role: "user",
    content: "x".repeat(300_000),
  };
  const retained = buildReplacementHistory(
    [oversized, { type: "compaction_trigger" }],
    compacted,
  );
  assert.equal(retained.length, 2);
  assert.equal(retained[0].role, "user");
  assert.equal(typeof retained[0].content, "string");
  assert.match(retained[0].content as string, /truncated/);
  assert.ok(
    Math.ceil(Buffer.byteLength(JSON.stringify(retained[0]), "utf8") / 4) <=
      64_000,
  );

  const multipart = {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "x".repeat(300_000),
    }, {
      type: "input_text",
      text: "later text",
    }],
  };
  const multipartRetained = buildReplacementHistory(
    [multipart, { type: "compaction_trigger" }],
    compacted,
  );
  assert.ok(Array.isArray(multipartRetained[0].content));
  assert.ok((multipartRetained[0].content as any[]).every(
    (item) => item.type !== "input_text" || typeof item.text === "string",
  ));
});

test("replacement history does not let non-text content bypass its budget", () => {
  const compacted = { type: "compaction", encrypted_content: "opaque" };
  const oversizedImage = {
    type: "message",
    role: "user",
    content: [{
      type: "input_image",
      image_url: `data:image/png;base64,${"a".repeat(300_000)}`,
    }, {
      type: "input_text",
      text: "caption",
    }],
  };

  assert.deepEqual(
    buildReplacementHistory(
      [oversizedImage, { type: "compaction_trigger" }],
      compacted,
    ),
    [compacted],
  );
});

test("remote compaction checkpoints parse, replay, and safely ignore stale input", () => {
  const compacted = { type: "compaction", encrypted_content: "opaque" };
  const parsed = parseRemoteCompactionSse([
    `data: ${JSON.stringify({ type: "response.output_item.done", item: compacted })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "response-1" } })}`,
  ].join("\n"));
  assert.deepEqual(parsed, { compaction: compacted, responseId: "response-1" });
  const checkpointInput = [
    { role: "user", content: [{ type: "input_text", text: checkpointMarker("cp-1") }] },
  ];
  const details = {
    type: "pi-codex-remote-compaction" as const,
    version: 2 as const,
    checkpointId: "cp-1",
    endpoint: "https://example.test",
    output: [compacted],
    readFiles: [],
    modifiedFiles: [],
    toolCatalogFingerprint: "catalog-1",
    contextFingerprint: fingerprintCheckpointInput(
      checkpointInput,
      checkpointMarker("cp-1"),
    ),
  };
  assert.equal(isRemoteCompactionDetails(details), true);
  assert.equal(
    isRemoteCompactionDetails({ ...details, version: 1 }),
    true,
    "legacy Subrouter checkpoints remain readable",
  );
  const payload: any = { input: checkpointInput };
  const suffix = [{ type: "message", role: "user", content: [{ type: "input_text", text: "tail" }] }];
  const suffixPayload: any = {
    input: [...checkpointInput, ...suffix],
  };
  const suffixFingerprint = fingerprintCheckpointSuffix(
    suffixPayload.input,
    checkpointMarker("cp-1"),
    1,
  );
  assert.ok(suffixFingerprint);
  const mismatchedSuffix: any = {
    input: [
      ...checkpointInput,
      { type: "message", role: "user", content: [{ type: "input_text", text: "changed" }] },
    ],
  };
  installRemoteCheckpoint(mismatchedSuffix, {
    ...details,
    contextFingerprint: suffixFingerprint,
    retainedContextItemCount: 1,
  }, {
    toolCatalogFingerprint: "catalog-1",
    contextFingerprint: fingerprintCheckpointSuffix(
      mismatchedSuffix.input,
      checkpointMarker("cp-1"),
      1,
    ),
  });
  assert.match(JSON.stringify(mismatchedSuffix), /changed/);
  installRemoteCheckpoint(payload, details, {
    toolCatalogFingerprint: "catalog-1",
    contextFingerprint: fingerprintCheckpointInput(payload.input, checkpointMarker("cp-1")),
  });
  assert.deepEqual(payload.input, details.output);
  const stale: any = {
    input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker("cp-1") }] }],
  };
  installRemoteCheckpoint(stale, details, { toolCatalogFingerprint: "catalog-2" });
  assert.match(JSON.stringify(stale), /cp-1/);
  const unrelated: any = { input: [{ role: "user", content: "new request" }] };
  installRemoteCheckpoint(unrelated, details);
  assert.deepEqual(unrelated.input, [{ role: "user", content: "new request" }]);

  const retained = buildReplacementHistory(
    [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }, { type: "function_call", role: "assistant" }, { type: "compaction_trigger" }],
    compacted,
  );
  assert.deepEqual(retained.map((item) => item.content ?? item.type), ["first", "compaction"]);
});

test("official Codex binary applies add and update hunks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-test-"));
  try {
    const add = await run(
      resolveCodexExecutable(),
      [
        CODEX_APPLY_PATCH_FLAG,
        "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
      ],
      cwd,
    );
    assert.equal(add.code, 0, add.stderr);
    assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hello\n");

    const update = await run(
      resolveCodexExecutable(),
      [
        CODEX_APPLY_PATCH_FLAG,
        "*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+hello from Codex\n*** End Patch",
      ],
      cwd,
    );
    assert.equal(update.code, 0, update.stderr);
    assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hello from Codex\n");

    await writeFile(
      join(cwd, "hello.txt"),
      "\tfunction example() {\n\t\treturn \"old\";\n\t}\n",
    );
    const whitespaceFuzzy = await run(
      resolveCodexExecutable(),
      [
        CODEX_APPLY_PATCH_FLAG,
        "*** Begin Patch\n*** Update File: hello.txt\n@@\n function example() {\n-\treturn \"old\";\n+\treturn \"new\";\n }\n*** End Patch",
      ],
      cwd,
    );
    assert.equal(whitespaceFuzzy.code, 0, whitespaceFuzzy.stderr);
    assert.equal(
      await readFile(join(cwd, "hello.txt"), "utf8"),
      "function example() {\n\treturn \"new\";\n}\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("burst rows surface failure diagnostics instead of a pending label", () => {
  const PATCH =
    "*** Begin Patch\n*** Add File: x.ts\n+x\n*** End Patch";
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    getActiveTools: () => ["apply_patch", "web_search"],
    getAllTools: () => [...tools.values()],
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);
  const emit = (name: string, event?: any, ctx?: any) => {
    for (const handler of handlers.get(name) ?? []) handler(event, ctx);
  };
  const applyPatch = tools.get("apply_patch");
  const webSearch = tools.get("web_search");
  assert.ok(applyPatch && webSearch);

  emit("session_start", {}, {
    sessionManager: { getBranch: () => [] },
    hasUI: false,
  });
  emit("agent_start", {}, { hasUI: false });
  emit("message_start", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "p1", name: "apply_patch" },
        { type: "toolCall", id: "p2", name: "apply_patch" },
      ],
    },
  });

  withCleanTui(() => {
    const theme = renderTheme();
    const ctx1 = renderCtx("p1");
    const ctx2 = renderCtx("p2");
    const leader = applyPatch.renderCall({ patch: PATCH }, theme, ctx1);
    // p2 groups into p1's burst: its own row renders nothing.
    const follower = applyPatch.renderCall({ patch: PATCH }, theme, ctx2);
    assert.equal(follower.render(120).join("\n"), "");

    // Both patches fail (thrown errors carry text, not diff details).
    const errorResult = {
      content: [{
        type: "text",
        text: "Codex apply_patch exited with status 1: context mismatch",
      }],
    };
    applyPatch.renderResult(
      errorResult,
      { expanded: false, isPartial: false },
      theme,
      { ...ctx1, isError: true },
    );
    applyPatch.renderResult(
      errorResult,
      { expanded: false, isPartial: false },
      theme,
      { ...ctx2, isError: true },
    );
    ctx1.expanded = true;
    const expanded = applyPatch.renderCall({ patch: PATCH }, theme, ctx1);
    const expandedText = stripVTControlCharacters(expanded.render(120).join("\n"));
    assert.match(expandedText, /exited with status 1: context mismatch/);
    assert.doesNotMatch(expandedText, /pending/);
    assert.match(stripVTControlCharacters(leader.render(120).join("\n")), /apply_patch x\.ts/);
  });

  // A solo failed web_search shows its error text when expanded.
  emit("message_start", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "w1", name: "web_search" }],
    },
  });
  withCleanTui(() => {
    const theme = renderTheme();
    const ctx = renderCtx("w1");
    webSearch.renderCall({ search_query: [{ q: "x" }] }, theme, ctx);
    webSearch.renderResult(
      { content: [{ type: "text", text: "web_search requires an openai-codex model" }] },
      { expanded: false, isPartial: false },
      theme,
      { ...ctx, isError: true },
    );
    ctx.expanded = true;
    const expanded = webSearch.renderCall(
      { search_query: [{ q: "x" }] },
      theme,
      ctx,
    );
    const expandedText = stripVTControlCharacters(expanded.render(120).join("\n"));
    assert.match(expandedText, /web_search requires an openai-codex model/);
    assert.doesNotMatch(expandedText, /pending/);
  });
});

test("standalone result rows render once while pi is mid-render", async () => {
  const { ToolExecutionComponent } = await import(
    "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
  );
  initTheme(undefined, false);

  const tools = new Map<string, any>();
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    getActiveTools: () => ["apply_patch"],
    getAllTools: () => [...tools.values()],
    setActiveTools() {},
    on() {},
  } as unknown as ExtensionAPI;
  piCodex(pi);
  const applyPatch = tools.get("apply_patch");
  assert.ok(applyPatch);

  const PATCH =
    "*** Begin Patch\n*** Add File: x.ts\n+x\n*** End Patch";
  // A real pi row: updateDisplay invokes renderCall before renderResult, so
  // a synchronous self-invalidation inside recordResult used to re-enter the
  // render and append the result a second time.
  const component = new ToolExecutionComponent(
    "apply_patch",
    "standalone-once",
    { patch: PATCH },
    {},
    applyPatch,
    { requestRender() {} } as any,
    process.cwd(),
  );
  component.updateResult(
    {
      content: [{ type: "text", text: "failed diagnostic" }],
      isError: true,
    },
    false,
  );

  const occurrences = (lines: string[], needle: string) =>
    stripVTControlCharacters(lines.join("\n")).split(needle).length - 1;
  // Before the deferred invalidation fires: exactly one result.
  assert.equal(occurrences(component.render(120), "failed diagnostic"), 1);
  assert.equal(occurrences(component.render(120), "x.ts"), 1);
  // After the deferred invalidation fires: still exactly one result.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(occurrences(component.render(120), "failed diagnostic"), 1);
  assert.equal(occurrences(component.render(120), "x.ts"), 1);
});

test("second standalone call refreshes its own header after completing", async () => {
  const { ToolExecutionComponent } = await import(
    "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
  );
  initTheme(undefined, false);

  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    getActiveTools: () => ["apply_patch"],
    getAllTools: () => [...tools.values()],
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);
  const emit = (name: string, event?: any, ctx?: any) => {
    for (const handler of handlers.get(name) ?? []) handler(event, ctx);
  };
  const applyPatch = tools.get("apply_patch");
  assert.ok(applyPatch);

  // Two adjacent standalone calls are groupable in the tracker's entries;
  // solo rendering must ignore that and refresh the changed row itself.
  emit("session_start", {}, {
    sessionManager: { getBranch: () => [] },
    hasUI: false,
  });
  emit("agent_start", {}, { hasUI: false });
  emit("message_start", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "sa-1", name: "apply_patch" },
        { type: "toolCall", id: "sa-2", name: "apply_patch" },
      ],
    },
  });
  const PATCH =
    "*** Begin Patch\n*** Add File: x.ts\n+x\n*** End Patch";
  const mkComponent = (id: string) =>
    new ToolExecutionComponent(
      "apply_patch",
      id,
      { patch: PATCH },
      {},
      applyPatch,
      { requestRender() {} } as any,
      process.cwd(),
    );
  const first = mkComponent("sa-1");
  const second = mkComponent("sa-2");
  const errorResult = {
    content: [{ type: "text", text: "failed diagnostic" }],
    isError: true,
  };
  const render = (c: InstanceType<typeof ToolExecutionComponent>) =>
    c.render(120).join("\n");

  const firstBefore = render(first);
  first.updateResult(errorResult, false);
  await new Promise((resolve) => setImmediate(resolve));
  const firstRefreshed = render(first);
  assert.match(stripVTControlCharacters(firstRefreshed), /failed diagnostic/);
  // The first row's header repainted after its own result.
  assert.notEqual(firstRefreshed, firstBefore);

  second.updateResult(errorResult, false);
  // Immediately after the result pi has drawn the header with the pending
  // background (renderCall ran before renderResult).
  const secondMidRender = render(second);
  await new Promise((resolve) => setImmediate(resolve));
  const secondRefreshed = render(second);
  // The second row's header must repaint (pending -> error background); with
  // the calculated-leader refresh it stayed pending forever.
  assert.notEqual(secondRefreshed, secondMidRender);
  // No duplicate output from the deferred refresh.
  assert.equal(
    stripVTControlCharacters(secondRefreshed).split("failed diagnostic").length - 1,
    1,
  );
  assert.equal(
    stripVTControlCharacters(firstRefreshed).split("failed diagnostic").length - 1,
    1,
  );
});
