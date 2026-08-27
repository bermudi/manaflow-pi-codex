import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
  CompactionSummaryMessageComponent,
  generateDiffString,
  renderDiff,
  SettingsManager,
  type ToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, type Box } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CODEX_APPLY_PATCH_FLAG,
  resolveCodexExecutable,
} from "../src/codex-binary.ts";
import {
  buildCompactHeaders,
  buildCompactRequest,
  buildReplacementHistory,
  checkpointMarker,
  convertCodexTools,
  fingerprintContext,
  fetchRemoteCompaction,
  fingerprintCheckpointSuffix,
  installRemoteCheckpoint,
  isRemoteCompactionDetails,
  parseRemoteCompactionSse,
  retainedContextItems,
  REMOTE_COMPACTION_VERSION,
  toPiUsage,
  type RemoteCompactionDetails,
  resolveCompactUrl,
} from "../src/remote-compaction.ts";
import {
  buildWebSearchInput,
  boundedWebSearchDetails,
  fetchCodexWebSearch,
  resolveWebSearchUrl,
  summarizeWebSearchCommands,
  type WebSearchCommands,
  type WebSearchDetails,
} from "../src/web-search.ts";
import {
  burstBox,
  burstBullet,
  burstDetailBlock,
  BurstTracker,
  emptyBurstRow,
  isCleanTuiActive,
  type BurstTheme,
} from "../src/clean-burst.ts";
import {
  ToolContractRegistry,
  fingerprintToolSpecs,
} from "../src/tool-contract.ts";
import {
  CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  resolveCodexTruncationPolicy,
  truncateCodexOutput,
} from "../src/output-truncation.ts";

const grammarPath = fileURLToPath(new URL("../src/apply-patch.lark", import.meta.url));
const applyPatchGrammar = readFileSync(grammarPath, "utf8");
const replacedTools = ["edit", "write"] as const;
// CompactionSummaryMessageComponent and generateDiffString are public root
// exports of @earendil-works/pi-coding-agent. Never reach into pi's dist
// tree by file URL: the bundled pi distribution does not ship those files on
// disk, and `import.meta.resolve` bypasses the extension sandbox module map,
// which is what broke npm-installed 0.1.5.
const compactRendererMarker: unique symbol = Symbol.for(
  "pi-codex.compact-compaction-renderer.v1",
) as any;
const CODEX_SOL_CONTEXT_WINDOW = 272_000;
const CODEX_SOL_AUTO_COMPACT_LIMIT = codexAutoCompactLimit(CODEX_SOL_CONTEXT_WINDOW);
const CODEX_SOL_RESERVE_TOKENS = codexCompactionReserve(CODEX_SOL_CONTEXT_WINDOW);
const CODEX_FAST_SERVICE_TIER = "priority";
const CODEX_FAST_MODE_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
const CODEX_FAST_MODE_ENTRY = "pi-codex-fast-mode";
const CODEX_FAST_MODE_STATUS = "pi-codex-fast-mode";
const compactionPatchMarker: unique symbol = Symbol.for(
  "pi-codex.provider-compaction-threshold.v1",
) as any;
let activeCodexContextWindow: number | undefined;

type PatchedSettingsPrototype = SettingsManager & {
  [compactionPatchMarker]?: true;
};

type PatchableCompactionComponent = {
  [compactRendererMarker]?: true;
  updateDisplay: () => void;
};

function installCompactCompactionRenderer() {
  const prototype =
    CompactionSummaryMessageComponent.prototype as unknown as PatchableCompactionComponent;
  if (prototype[compactRendererMarker]) return;

  const original = prototype.updateDisplay;
  prototype.updateDisplay = function () {
    // Keep expanded summaries readable, but make the normal status a single
    // content line with no vertical box padding.
    (this as any).paddingY = (this as any).expanded ? 1 : 0;
    original.call(this);
    if ((this as any).expanded) return;

    const children = (this as any).children as Array<{ text?: string }>;
    const label = children[0]?.text;
    const status = children.at(-1)?.text;
    if (typeof label !== "string" || typeof status !== "string") return;

    (this as any).clear();
    (this as any).addChild(new Text(`${label} ${status}`, 0, 0));
  };
  Object.defineProperty(prototype, compactRendererMarker, { value: true });
}

function isOpenAICodexModel(model: Model<any> | undefined): model is Model<any> {
  // Codex-compatible providers can be local/subrouter aliases while still
  // speaking the OpenAI Responses protocol. This controls Codex tool behavior;
  // remote compaction has a narrower capability check below.
  return model?.provider === "openai-codex" || model?.api === "openai-codex-responses";
}

function supportsCodexRemoteCompaction(
  model: Model<any> | undefined,
): model is Model<any> {
  if (!isOpenAICodexModel(model)) return false;
  const declared =
    (model as any).supportsRemoteCompaction ??
    (model.compat as any)?.supportsRemoteCompaction;
  if (typeof declared === "boolean") return declared;
  return model.provider === "openai-codex" || model.provider === "subrouter";
}

function isCodexSolModel(model: Model<any> | undefined): boolean {
  return isOpenAICodexModel(model) && model?.id === "gpt-5.6-sol";
}

function supportsCodexFastMode(model: Model<any> | undefined): boolean {
  return isOpenAICodexModel(model) && CODEX_FAST_MODE_MODELS.has(model?.id ?? "");
}

function codexAutoCompactLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9);
}

// pi compacts when usage > (window - reserve), while Codex compacts when
// usage >= auto_compact_token_limit. The extra token aligns the first trigger.
function codexCompactionReserve(contextWindow: number): number {
  return contextWindow - codexAutoCompactLimit(contextWindow) + 1;
}

function formatWorkingElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function installCodexCompactionThreshold() {
  const prototype = SettingsManager.prototype as PatchedSettingsPrototype;
  if (prototype[compactionPatchMarker]) return;

  const original = SettingsManager.prototype.getCompactionSettings;
  SettingsManager.prototype.getCompactionSettings = function () {
    const settings = original.call(this);
    if (!activeCodexContextWindow) return settings;
    return {
      ...settings,
      reserveTokens: codexCompactionReserve(activeCodexContextWindow),
    };
  };
  Object.defineProperty(prototype, compactionPatchMarker, { value: true });
}

const applyPatchSchema = Type.Object({
  patch: Type.String({
    description: "The complete *** Begin Patch ... *** End Patch payload",
  }),
});

const searchQuerySchema = Type.Object({
  q: Type.String(),
  recency: Type.Optional(Type.Integer({ minimum: 0 })),
  domains: Type.Optional(Type.Array(Type.String())),
});

const webSearchSchema = Type.Object({
  search_query: Type.Optional(Type.Array(searchQuerySchema, { maxItems: 4 })),
  image_query: Type.Optional(Type.Array(searchQuerySchema, { maxItems: 2 })),
  open: Type.Optional(
    Type.Array(
      Type.Object({
        ref_id: Type.String(),
        lineno: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
    ),
  ),
  click: Type.Optional(
    Type.Array(Type.Object({ ref_id: Type.String(), id: Type.Integer({ minimum: 0 }) })),
  ),
  find: Type.Optional(
    Type.Array(Type.Object({ ref_id: Type.String(), pattern: Type.String() })),
  ),
  screenshot: Type.Optional(
    Type.Array(
      Type.Object({
        ref_id: Type.String(),
        pageno: Type.Integer({ minimum: 0 }),
      }),
    ),
  ),
  finance: Type.Optional(
    Type.Array(
      Type.Object({
        ticker: Type.String(),
        type: StringEnum(["equity", "fund", "crypto", "index"] as const),
        market: Type.Optional(Type.String()),
      }),
    ),
  ),
  weather: Type.Optional(
    Type.Array(
      Type.Object({
        location: Type.String(),
        start: Type.Optional(Type.String()),
        duration: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
    ),
  ),
  sports: Type.Optional(
    Type.Array(
      Type.Object({
        tool: Type.Optional(StringEnum(["sports"] as const)),
        fn: StringEnum(["schedule", "standings"] as const),
        league: StringEnum(
          ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const,
        ),
        team: Type.Optional(Type.String()),
        opponent: Type.Optional(Type.String()),
        date_from: Type.Optional(Type.String()),
        date_to: Type.Optional(Type.String()),
        num_games: Type.Optional(Type.Integer({ minimum: 1 })),
        locale: Type.Optional(Type.String()),
      }),
    ),
  ),
  time: Type.Optional(
    Type.Array(Type.Object({ utc_offset: Type.String() })),
  ),
  response_length: Type.Optional(StringEnum(["short", "medium", "long"] as const)),
});

type ApplyPatchDetails = {
  patch: string;
  output: string;
  changedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
};

function isCodexModel(model: Model<any> | undefined): boolean {
  // Tool selection follows the wire protocol first. A subrouter alias may
  // expose the Codex Responses API without containing "codex" in its name.
  // DeepSeek-v4 models are trained on the Codex harness and emit native
  // apply_patch output.
  const modelId = model?.id ?? "";
  return isOpenAICodexModel(model) ||
    /(?:^|[-_.])codex(?:$|[-_.])/.test(modelId) ||
    /(?:^|[-_./])deepseek-v4(?:-|$)/.test(modelId);
}

function changedPathsFromOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.match(/^[AMD] (.+)$/)?.[1])
    .filter((path): path is string => path !== undefined);
}

function pathsFromPatch(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const path = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/)?.[1];
    const movePath = line.match(/^\*\*\* Move to: (.+)$/)?.[1];
    if (path) paths.add(path);
    if (movePath) paths.add(movePath);
  }
  return [...paths];
}

// ── Clean burst rendering (mirrors bermudis-pi-goodies clean-tui.ts) ──
const burstTracker = new BurstTracker();

// ── Patch path display ──
// apply_patch paths resolve against the session cwd (Codex applies them
// there). Collapsed rows show them relative to cwd when possible, else
// ~-anchored, so multi-file bursts stay scannable instead of wrapping
// absolute paths mid-word.
const MAX_PATCH_PATH_LINES = 8;

function shortenHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd) return shortenHome(path);
  const base = resolve(cwd);
  const abs = resolve(base, path);
  if (abs === base) return ".";
  if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
  return shortenHome(abs);
}

function patchDisplayPaths(patch: string, cwd: string | undefined): string[] {
  return pathsFromPatch(patch).map((path) => displayPath(path, cwd));
}

function cappedPaths(paths: string[]): { shown: string[]; hidden: number } {
  if (paths.length <= MAX_PATCH_PATH_LINES) return { shown: paths, hidden: 0 };
  return {
    shown: paths.slice(0, MAX_PATCH_PATH_LINES - 1),
    hidden: paths.length - (MAX_PATCH_PATH_LINES - 1),
  };
}

function applyPatchLabel(patch: string, cwd?: string): string {
  return patchDisplayPaths(patch, cwd).join(", ") || "patch";
}

/** `title` plus one short path per line (single path stays on the title line). */
function applyPatchCallHeader(
  patch: string,
  title: string,
  theme: BurstTheme,
  cwd?: string,
): string {
  const paths = patchDisplayPaths(patch, cwd);
  if (paths.length <= 1) {
    return `${title} ${theme.fg("accent", paths[0] ?? "patch")}`;
  }
  const { shown, hidden } = cappedPaths(paths);
  const lines = shown.map((path) => `  ${theme.fg("accent", path)}`);
  if (hidden > 0) lines.push(`  ${theme.fg("muted", `… +${hidden} more`)}`);
  return `${title}\n${lines.join("\n")}`;
}

function applyPatchBullet(entry: any, theme: BurstTheme, cwd?: string): string {
  const paths = patchDisplayPaths(entry.args?.patch ?? "", cwd);
  if (!paths.length) return burstBullet(theme, "patch", entry.isError);
  const { shown, hidden } = cappedPaths(paths);
  const accent = entry.isError ? "error" : "accent";
  // burstBullet's `  • ` prefix is four columns; continuations align under it.
  const lines = [burstBullet(theme, shown[0], entry.isError)];
  for (const path of shown.slice(1)) lines.push(`    ${theme.fg(accent, path)}`);
  if (hidden > 0) lines.push(`    ${theme.fg("muted", `… +${hidden} more`)}`);
  return lines.join("\n");
}

function webSearchLabel(commands: unknown): string {
  return summarizeWebSearchCommands(commands as WebSearchCommands);
}

function webSearchBullet(entry: any, theme: BurstTheme): string {
  return burstBullet(theme, webSearchLabel(entry.args ?? {}), entry.isError);
}

/** Text content of a tool result — the only diagnostic thrown errors carry. */
function resultText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

// ── Default (standalone) rendering — used when clean-tui is not active ──
// Mirrors pi's native edit rows: the call shows the title and touched paths,
// and the result (colored diff / search output) stays visible. State comes
// from the same tracker so box colors update when results land.

function applyPatchDefaultRenderCall(
  args: { patch: string },
  theme: BurstTheme,
  context: any,
): Box {
  const { pending, isError } = burstTracker.solo(
    context?.toolCallId,
    "apply_patch",
    args,
    context?.invalidate,
  );
  const title = theme.fg("toolTitle", theme.bold("apply_patch"));
  const header = applyPatchCallHeader(args?.patch ?? "", title, theme, context?.cwd);
  return burstBox(theme, pending, isError, header);
}

function applyPatchDefaultRenderResult(
  result: any,
  theme: BurstTheme,
  context: any,
): Box {
  const ctx = context as any;
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
  const isError = !!ctx?.isError || !!(result as any)?.isError;
  burstTracker.recordResult(ctx?.toolCallId, result, isError);
  const details = result?.details as ApplyPatchDetails | undefined;
  const renderedDiffs = details?.diffs
    .map(
      ({ path, diff }) =>
        `${theme.fg("muted", displayPath(path, cwd))}\n${renderDiff(diff, { filePath: path })}`,
    )
    .join("\n\n");
  const text =
    renderedDiffs ??
    (details?.changedPaths.length
      ? `Updated ${details.changedPaths.map((path) => displayPath(path, cwd)).join(", ")}`
      : (result?.content ?? [])
          .map((item: any) => (item.type === "text" ? item.text : ""))
          .join("\n"));
  return burstBox(theme, false, isError, text || "(no output)");
}

function webSearchDefaultRenderCall(
  commands: unknown,
  theme: BurstTheme,
  context: any,
): Box {
  const { pending, isError } = burstTracker.solo(
    context?.toolCallId,
    "web_search",
    commands,
    context?.invalidate,
  );
  const header = `${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("muted", webSearchLabel(commands))}`;
  return burstBox(theme, pending, isError, header);
}

function webSearchDefaultRenderResult(
  result: any,
  theme: BurstTheme,
  context: any,
): Box {
  const ctx = context as any;
  const isError = !!ctx?.isError || !!(result as any)?.isError;
  burstTracker.recordResult(ctx?.toolCallId, result, isError);
  const rawOutput = (result?.details as WebSearchDetails | undefined)?.rawOutput;
  const output =
    ctx?.expanded && rawOutput
      ? rawOutput
      : (result?.content ?? [])
          .map((item: any) => (item.type === "text" ? item.text : ""))
          .join("\n");
  const visible =
    ctx?.expanded || output.length <= 2_000
      ? output
      : `${output.slice(0, 2_000).trimEnd()}\n…`;
  return burstBox(theme, false, isError, visible || "(no output)");
}

async function readPatchFile(cwd: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch {
    return "";
  }
}

export default function piCodex(pi: ExtensionAPI) {
  installCodexCompactionThreshold();
  installCompactCompactionRenderer();
  burstTracker.registerHandlers(pi);
  let applyPatchSelected: boolean | undefined;
  let webSearchSelected: boolean | undefined;
  let retryTurnState: string | undefined;
  let turnState: string | undefined;
  let fastModeEnabled = false;
  let workingStartedAt: number | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  const removedForCodex = new Set<string>();
  const toolContracts = new ToolContractRegistry();
  let activeToolCatalogFingerprint = "";

  // Codex's model_visible_specs() contains direct tools only. Deferred
  // contracts stay registered for Pi's tool-search lifecycle and are included
  // in the catalog fingerprint, but must not be sent in the initial
  // compaction request.
  function activeCodexToolSpecs(includeDeferred = false) {
    return pi
      .getAllTools()
      .filter((tool) => pi.getActiveTools().includes(tool.name))
      .flatMap((tool) => {
        const contract = toolContracts.get(tool.name);
        if (contract?.exposure === "hidden") return [];
        if (contract && !contract.isDirect() && !includeDeferred) return [];
        const contractTool = contract?.toCodexTool();
        return [contractTool ?? {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...((tool as any).constrainedSampling
            ? { constrainedSampling: (tool as any).constrainedSampling }
            : {}),
        }];
      });
  }

  function activeCodexToolFingerprint(model: Model<any> | undefined): string {
    const tools = activeCodexToolSpecs();
    const deferredTools = activeCodexToolSpecs(true).filter(
      (tool) => !tools.some((direct) => direct.name === tool.name),
    );
    const directWireTools = model
      ? convertCodexTools(model, tools) ?? tools
      : tools;
    const deferredWireTools = model
      ? convertCodexTools(model, deferredTools) ?? deferredTools
      : deferredTools;
    return fingerprintToolSpecs([
      ...directWireTools,
      {
        name: "__pi_codex_deferred_tools__",
        tools: deferredWireTools,
      },
      {
        name: "__pi_codex_model_compat__",
        provider: model?.provider,
        model: model?.id,
        api: model?.api,
        contextWindow: model?.contextWindow,
        supportsStrictMode: (model?.compat as any)?.supportsStrictMode,
        supportsOpenAIGrammarTools: (model?.compat as any)?.supportsOpenAIGrammarTools,
        supportsToolSearch: (model?.compat as any)?.supportsToolSearch,
      },
    ]);
  }

  function outputPolicy(model: Model<any> | undefined, budget: number) {
    return budget === CODEX_DEFAULT_OUTPUT_BUDGET_BYTES
      ? resolveCodexTruncationPolicy(model)
      : { type: "bytes" as const, limit: budget };
  }

  function truncationUnits(text: string): number {
    return Buffer.byteLength(text, "utf8");
  }

  function latestRemoteCompaction(ctx: { sessionManager: { getBranch(): readonly any[] } }) {
    return [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry: any) => entry.type === "compaction" && isRemoteCompactionDetails(entry.details))
      ?.details as RemoteCompactionDetails | undefined;
  }

  function syncTools(model: Model<any> | undefined) {
    activeCodexContextWindow = isOpenAICodexModel(model)
      ? model?.contextWindow
      : undefined;
    const active = new Set(pi.getActiveTools());
    applyPatchSelected ??= active.has("apply_patch");
    webSearchSelected ??= active.has("web_search");

    if (isCodexModel(model) && applyPatchSelected) {
      active.add("apply_patch");
      for (const tool of replacedTools) {
        if (active.delete(tool)) removedForCodex.add(tool);
      }
    } else {
      active.delete("apply_patch");
      for (const tool of removedForCodex) active.add(tool);
      removedForCodex.clear();
    }
    if (isOpenAICodexModel(model) && webSearchSelected) active.add("web_search");
    else active.delete("web_search");

    pi.setActiveTools([...active]);
  }

  function restoreFastMode(ctx: { sessionManager: { getBranch(): readonly any[] } }) {
    const saved = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (entry: any) =>
          entry.type === "custom" &&
          entry.customType === CODEX_FAST_MODE_ENTRY &&
          typeof entry.data?.enabled === "boolean",
      );
    fastModeEnabled = saved?.data.enabled ?? false;
  }

  function updateFastModeStatus(ctx: any) {
    if (!ctx.hasUI) return;
    const visible = fastModeEnabled && supportsCodexFastMode(ctx.model);
    ctx.ui.setStatus(
      CODEX_FAST_MODE_STATUS,
      visible ? ctx.ui.theme.fg("accent", "fast") : undefined,
    );
  }

  function startWorkingTicker(ctx: any) {
    if (!ctx.hasUI || workingTimer) return;
    workingStartedAt = Date.now();
    const update = () => {
      if (workingStartedAt === undefined) return;
      ctx.ui.setWorkingMessage(
        `Working (${formatWorkingElapsed(Date.now() - workingStartedAt)})...`,
      );
    };
    update();
    workingTimer = setInterval(update, 1_000);
    workingTimer.unref?.();
  }

  function stopWorkingTicker(ctx?: any) {
    if (workingTimer) clearInterval(workingTimer);
    workingTimer = undefined;
    workingStartedAt = undefined;
    if (ctx?.hasUI) ctx.ui.setWorkingMessage();
  }

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast mode (usage: /fast [on|off|status])",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        const supported = supportsCodexFastMode(ctx.model);
        ctx.ui.notify(
          supported
            ? `Codex Fast mode is ${fastModeEnabled ? "on" : "off"} for ${ctx.model?.id}.`
            : `${ctx.model?.provider ?? "No provider"}/${ctx.model?.id ?? "no model"} does not advertise Codex Fast mode.`,
          "info",
        );
        return;
      }
      if (action && !["on", "off", "toggle"].includes(action)) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }

      fastModeEnabled =
        action === "on" ? true : action === "off" ? false : !fastModeEnabled;
      pi.appendEntry(CODEX_FAST_MODE_ENTRY, { enabled: fastModeEnabled });
      updateFastModeStatus(ctx);
      const supportNote = supportsCodexFastMode(ctx.model)
        ? ""
        : " (the current model does not advertise Fast support)";
      ctx.ui.notify(
        `Codex Fast mode ${fastModeEnabled ? "enabled" : "disabled"}${supportNote}.`,
        "info",
      );
    },
  });

  const webSearchDefinition: ToolDefinition<typeof webSearchSchema> = {
    name: "web_search",
    label: "Web Search",
    description:
      "Search and browse the live web using OpenAI Codex search. Supports search queries, page opening, links, find-in-page, screenshots, finance, weather, sports, and time.",
    promptSnippet: "Search and browse current web information through OpenAI Codex",
    promptGuidelines: [
      "Use web_search for current, niche, or source-dependent information instead of answering from memory.",
      "Use web_search open, click, and find operations to inspect sources after searching.",
    ],
    parameters: webSearchSchema,
    async execute(_toolCallId, commands, signal, _onUpdate, ctx) {
      const model = ctx.model;
      if (!model || !isOpenAICodexModel(model)) {
        throw new Error("web_search requires an openai-codex model");
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? "OpenAI Codex OAuth token is unavailable" : auth.error);
      }
      const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
      const endpoint = resolveWebSearchUrl(providerAuth?.auth.baseUrl ?? model.baseUrl);
      const input = buildWebSearchInput(ctx.sessionManager.getBranch());
      const result = await fetchCodexWebSearch({
        endpoint,
        token: auth.apiKey,
        model,
        authHeaders: auth.headers as Record<string, string | null> | undefined,
        commands: commands as WebSearchCommands,
        sessionId: ctx.sessionManager.getSessionId(),
        input,
        signal,
      });
      const modelOutput = truncateCodexOutput(
        result.text,
        outputPolicy(model, webSearchContract.outputBudgetBytes),
      );
      return {
        content: [{ type: "text", text: modelOutput.content }],
        details: {
          commands,
          endpoint,
          rawOutput: boundedWebSearchDetails(result.text),
          results: result.response.results,
        } satisfies WebSearchDetails,
      };
    },
    renderShell: "self",
    renderCall(commands, theme, context) {
      // Without clean-tui, render in the standalone edit-like style.
      if (!isCleanTuiActive())
        return webSearchDefaultRenderCall(commands, theme, context);
      const ctx = context as any;
      const view = burstTracker.view(
        ctx?.toolCallId,
        "web_search",
        commands,
        ctx?.invalidate,
      );
      if (!view) return emptyBurstRow();
      const { burst } = view;
      const pending = burst.some((e) => !e.result);
      const isError = burst.some((e) => e.isError);
      const title = theme.fg("toolTitle", theme.bold("web_search"));
      let header: string;
      if (burst.length > 1) {
        header = `${title} ${theme.fg("muted", `×${burst.length}`)}`;
        header += `\n${burst.map((e) => webSearchBullet(e, theme)).join("\n")}`;
      } else {
        header = `${title} ${theme.fg("muted", webSearchLabel(commands))}`;
      }
      if (ctx?.expanded) {
        const blocks: string[] = [];
        for (const e of burst) {
          const label = webSearchLabel(e.args ?? {});
          if (!e.result) {
            if (burst.length > 1)
              blocks.push(theme.fg("warning", `— ${label}: pending`));
            continue;
          }
          const raw = (e.result.details as WebSearchDetails | undefined)
            ?.rawOutput;
          if (raw) {
            blocks.push(burstDetailBlock(theme, label, raw));
            continue;
          }
          // Completed without rawOutput: a failed search (thrown error).
          // The result text is the only diagnostic — surface it instead of
          // an endless "pending".
          blocks.push(
            burstDetailBlock(theme, label, resultText(e.result) || "(no output)", {
              error: !!e.isError,
            }),
          );
        }
        if (blocks.length) header += `\n${blocks.join("\n")}`;
      }
      return burstBox(theme, pending, isError, header);
    },
    renderResult(result, _options, _theme, context) {
      if (!isCleanTuiActive())
        return webSearchDefaultRenderResult(result, _theme, context);
      const ctx = context as any;
      burstTracker.recordResult(
        ctx?.toolCallId,
        result,
        !!ctx?.isError || !!(result as any)?.isError,
      );
      return emptyBurstRow();
    },
  };
  const webSearchContract = toolContracts.register(webSearchDefinition, {
    exposure: "direct",
    namespace: "web",
    search: { namespace: "web", keywords: ["browse", "search", "current information"] },
    schemaVersion: "1",
    capabilities: ["network", "external_context"],
    outputBudgetBytes: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  });
  pi.registerTool(webSearchContract.definition);

  const applyPatchDefinition: ToolDefinition<typeof applyPatchSchema> = {
    name: "apply_patch",
    label: "Apply Patch",
    description:
      "Use OpenAI Codex's apply_patch format to add, update, move, or delete files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    promptSnippet: "Apply an OpenAI Codex patch to add, update, move, or delete files",
    promptGuidelines: [
      "Use apply_patch for manual file edits; send a complete `*** Begin Patch` through `*** End Patch` patch.",
      "Do not invoke apply_patch through bash or use bash commands to create or edit files.",
      "If another agent may have edited a file, or apply_patch reports missing expected lines, re-read the affected region and retry with a smaller, current-context hunk.",
    ],
    parameters: applyPatchSchema,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: applyPatchGrammar },
    },
    executionMode: "sequential",
    renderShell: "self",

    async execute(_toolCallId, { patch }, signal, _onUpdate, ctx) {
      const patchPaths = pathsFromPatch(patch);
      const before = new Map(
        await Promise.all(
          patchPaths.map(async (path) => [path, await readPatchFile(ctx.cwd, path)] as const),
        ),
      );
      const executable = resolveCodexExecutable();
      const result = await pi.exec(executable, [CODEX_APPLY_PATCH_FLAG, patch], {
        cwd: ctx.cwd,
        signal,
      });
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter(Boolean)
        .join("\n");
      const rawModelOutput = result.code === 0
        ? output || "Patch applied successfully."
        : output || `Codex apply_patch exited with status ${result.code}`;
      const modelOutput = truncateCodexOutput(
        rawModelOutput,
        outputPolicy(ctx.model, applyPatchContract.outputBudgetBytes),
      );

      if (result.code !== 0) {
        throw new Error(modelOutput.content);
      }

      const changedPaths = changedPathsFromOutput(result.stdout);
      const diffPaths = [...new Set([...patchPaths, ...changedPaths])];
      const diffs = (
        await Promise.all(
          diffPaths.map(async (path) => {
            const oldContent = before.get(path) ?? "";
            const newContent = await readPatchFile(ctx.cwd, path);
            const diff = generateDiffString(oldContent, newContent).diff;
            return diff ? { path, diff } : undefined;
          }),
        )
      ).filter((diff): diff is { path: string; diff: string } => diff !== undefined);

      return {
        content: [{ type: "text", text: modelOutput.content }],
        details: {
          patch,
          output,
          changedPaths,
          diffs,
        } satisfies ApplyPatchDetails,
      };
    },

    renderCall(args, theme, context) {
      // Without clean-tui, render in the standalone edit-like style.
      if (!isCleanTuiActive())
        return applyPatchDefaultRenderCall(args, theme, context);
      const ctx = context as any;
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
      const patch = (args as { patch: string }).patch;
      const view = burstTracker.view(
        ctx?.toolCallId,
        "apply_patch",
        args,
        ctx?.invalidate,
      );
      if (!view) return emptyBurstRow();
      const { burst } = view;
      const pending = burst.some((e) => !e.result);
      const isError = burst.some((e) => e.isError);
      const title = theme.fg("toolTitle", theme.bold("apply_patch"));
      let header: string;
      if (burst.length > 1) {
        header = `${title} ${theme.fg("muted", `×${burst.length}`)}`;
        header += `\n${burst.map((e) => applyPatchBullet(e, theme, cwd)).join("\n")}`;
      } else {
        header = applyPatchCallHeader(patch, title, theme, cwd);
      }
      if (ctx?.expanded) {
        const blocks: string[] = [];
        for (const e of burst) {
          const label = applyPatchLabel(e.args?.patch ?? "", cwd);
          if (!e.result) {
            if (burst.length > 1)
              blocks.push(theme.fg("warning", `— ${label}: pending`));
            continue;
          }
          const diffs = (e.result.details as ApplyPatchDetails | undefined)
            ?.diffs ?? [];
          if (diffs.length) {
            const body = diffs
              .map(
                ({ path, diff }) =>
                  `${theme.fg("muted", displayPath(path, cwd))}\n${renderDiff(diff, { filePath: path })}`,
              )
              .join("\n\n");
            blocks.push(`\n${theme.fg("muted", `— ${label}`)}:\n${body}`);
            continue;
          }
          // Completed without diffs: a failed patch (thrown error) or a
          // no-op. The result text is the only diagnostic — surface it
          // instead of an endless "pending".
          blocks.push(
            burstDetailBlock(theme, label, resultText(e.result) || "(no output)", {
              error: !!e.isError,
            }),
          );
        }
        if (blocks.length) header += `\n${blocks.join("\n")}`;
      }
      return burstBox(theme, pending, isError, header);
    },

    renderResult(result, _options, _theme, context) {
      if (!isCleanTuiActive())
        return applyPatchDefaultRenderResult(result, _theme, context);
      const ctx = context as any;
      burstTracker.recordResult(
        ctx?.toolCallId,
        result,
        !!ctx?.isError || !!(result as any)?.isError,
      );
      return emptyBurstRow();
    },
  };
  const applyPatchContract = toolContracts.register(applyPatchDefinition, {
    exposure: "direct",
    namespace: "coding",
    search: { namespace: "coding", keywords: ["edit", "write", "patch", "files"] },
    schemaVersion: "1",
    capabilities: ["filesystem", "mutation"],
    parallelism: "sequential",
    outputBudgetBytes: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  });
  pi.registerTool(applyPatchContract.definition);

  // Codex applies one model-facing output policy to every tool executor. Pi
  // exposes this as a post-execution hook, so package-owned tools can retain
  // their raw details while built-in and third-party tools receive the same
  // middle truncation before their result enters the next model request.
  pi.on("tool_result", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    if (toolContracts.get(event.toolName)) return;
    const policy = resolveCodexTruncationPolicy(ctx.model);
    const textIndexes = event.content.flatMap((item: any, index: number) =>
      item.type === "text" && typeof item.text === "string" ? [index] : [],
    );
    const units = textIndexes.map((index) =>
      truncationUnits((event.content[index] as any).text),
    );
    const totalUnits = units.reduce((total, value) => total + value, 0);
    if (totalUnits <= policy.limit) return;

    // Retain the leading and trailing halves across all text slots. Each slot
    // stays on its original side of images or audio, so truncation cannot move
    // a later caption or question ahead of its associated attachment.
    const front = Array(units.length).fill(0) as number[];
    const back = Array(units.length).fill(0) as number[];
    let frontRemaining = Math.floor(policy.limit / 2);
    for (let index = 0; index < units.length && frontRemaining > 0; index++) {
      front[index] = Math.min(units[index], frontRemaining);
      frontRemaining -= front[index];
    }
    let backRemaining = policy.limit - Math.floor(policy.limit / 2);
    for (let index = units.length - 1; index >= 0 && backRemaining > 0; index--) {
      const available = units[index] - front[index];
      back[index] = Math.min(available, backRemaining);
      backRemaining -= back[index];
    }
    const allocations = new Map(
      textIndexes.map((contentIndex, textIndex) => [
        contentIndex,
        front[textIndex] + back[textIndex],
      ]),
    );
    const content = event.content.flatMap((item: any, index: number) => {
      const limit = allocations.get(index);
      if (limit === undefined) return [item];
      if (limit === 0) return [];
      return [{
        ...item,
        text: truncateCodexOutput(item.text, {
          type: policy.type,
          limit,
        }).content,
      }];
    });
    return {
      content,
      details: event.details,
      isError: event.isError,
      usage: event.usage,
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!supportsCodexRemoteCompaction(model)) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? "OpenAI Codex OAuth token is unavailable" : auth.error);
    }

    const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
    const previous = latestRemoteCompaction(ctx);
    const messages = [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ];
    const endpoint = resolveCompactUrl(providerAuth?.auth.baseUrl ?? model.baseUrl);
    const checkpointId = randomUUID();
    activeToolCatalogFingerprint = activeCodexToolFingerprint(model);
    const body = buildCompactRequest({
      model,
      messages,
      previousOutput: previous?.output,
      instructions: ctx.getSystemPrompt(),
      customInstructions: event.customInstructions,
      thinkingLevel: ctx.thinkingLevel,
      promptCacheKey: ctx.sessionManager.getSessionId(),
      serviceTier:
        fastModeEnabled && supportsCodexFastMode(model)
          ? CODEX_FAST_SERVICE_TIER
          : undefined,
      tools: activeCodexToolSpecs(),
    });
    const { response, text: responseText } = await fetchRemoteCompaction(endpoint, {
      method: "POST",
      headers: buildCompactHeaders(
        auth.apiKey,
        model.headers as Record<string, string | null> | undefined,
        auth.headers as Record<string, string | null> | undefined,
      ),
      body: JSON.stringify(body),
      signal: event.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Codex remote compaction failed (${response.status}): ${responseText || response.statusText}`,
      );
    }

    const parsedCompaction = parseRemoteCompactionSse(responseText);
    const { compaction } = parsedCompaction;
    const output = buildReplacementHistory(body.input, compaction);
    const retainedContext = retainedContextItems(
      model,
      ctx.sessionManager.getBranch(),
      event.preparation.firstKeptEntryId,
    );
    if (!retainedContext) {
      throw new Error(
        "Codex remote compaction could not establish the retained session context",
      );
    }

    const modifiedFiles = new Set([
      ...event.preparation.fileOps.written,
      ...event.preparation.fileOps.edited,
    ]);
    const readFiles = [...event.preparation.fileOps.read].filter(
      (path) => !modifiedFiles.has(path),
    );
    const details: RemoteCompactionDetails = {
      type: "pi-codex-remote-compaction",
      version: REMOTE_COMPACTION_VERSION,
      checkpointId,
      endpoint,
      output: output as Record<string, unknown>[],
      readFiles,
      modifiedFiles: [...modifiedFiles],
      responseId: parsedCompaction.responseId,
      turnState:
        response.headers.get("x-codex-turn-state") ??
        parsedCompaction.turnState,
      toolCatalogFingerprint: activeToolCatalogFingerprint,
      contextFingerprint: fingerprintContext(retainedContext),
      retainedContextItemCount: retainedContext.length,
      retainedHistoryVersion: "codex-responses-v2",
      tokenUsage: parsedCompaction.tokenUsage,
    };
    const responseTurnState =
      response.headers.get("x-codex-turn-state") ??
      parsedCompaction.turnState;
    if (responseTurnState) turnState = responseTurnState;
    retryTurnState = event.willRetry ? responseTurnState : undefined;

    return {
      compaction: {
        summary: checkpointMarker(checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        ...(parsedCompaction.tokenUsage
          ? { usage: toPiUsage(parsedCompaction.tokenUsage) }
          : {}),
        details,
      },
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    if (fastModeEnabled && supportsCodexFastMode(ctx.model)) {
      (event.payload as Record<string, unknown>).service_tier = CODEX_FAST_SERVICE_TIER;
    }
    const details = latestRemoteCompaction(ctx);
    if (details) {
      const currentToolCatalogFingerprint = activeCodexToolFingerprint(ctx.model);
      const input = ((event.payload as any)?.input ?? []) as readonly unknown[];
      const expectedContextFingerprint =
        details.contextFingerprint && details.retainedContextItemCount !== undefined
          ? fingerprintCheckpointSuffix(
              input,
              checkpointMarker(details.checkpointId),
              details.retainedContextItemCount,
            )
          : undefined;
      return installRemoteCheckpoint(event.payload, details, {
        toolCatalogFingerprint: currentToolCatalogFingerprint,
        ...(expectedContextFingerprint
          ? { contextFingerprint: expectedContextFingerprint }
          : {}),
      });
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    const state = retryTurnState ?? turnState;
    if (state) event.headers["x-codex-turn-state"] = state;
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    const headers = event.headers ?? {};
    const state =
      headers["x-codex-turn-state"] ??
      headers["X-Codex-Turn-State"];
    if (state) turnState ??= state;
  });

  pi.on("agent_end", () => {
    retryTurnState = undefined;
  });
  pi.on("turn_start", () => {
    retryTurnState = undefined;
    turnState = undefined;
  });
  pi.on("turn_end", () => {
    retryTurnState = undefined;
    turnState = undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    startWorkingTicker(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    stopWorkingTicker(ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    retryTurnState = undefined;
    turnState = undefined;
    restoreFastMode(ctx);
    syncTools(ctx.model);
    updateFastModeStatus(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    syncTools(event.model);
    updateFastModeStatus(ctx);
  });
  pi.on("session_shutdown", () => {
    stopWorkingTicker();
  });
}

export {
  applyPatchBullet,
  applyPatchCallHeader,
  applyPatchGrammar,
  changedPathsFromOutput,
  CODEX_FAST_MODE_MODELS,
  CODEX_FAST_SERVICE_TIER,
  CODEX_SOL_AUTO_COMPACT_LIMIT,
  CODEX_SOL_CONTEXT_WINDOW,
  CODEX_SOL_RESERVE_TOKENS,
  codexAutoCompactLimit,
  codexCompactionReserve,
  displayPath,
  formatWorkingElapsed,
  installCompactCompactionRenderer,
  isCodexModel,
  isCodexSolModel,
  isOpenAICodexModel,
  patchDisplayPaths,
  pathsFromPatch,
  supportsCodexFastMode,
};
