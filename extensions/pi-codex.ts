import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
  renderDiff,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
  fetchRemoteCompaction,
  installRemoteCheckpoint,
  isRemoteCompactionDetails,
  parseRemoteCompactionSse,
  type RemoteCompactionDetails,
  resolveCompactUrl,
} from "../src/remote-compaction.ts";

const grammarPath = fileURLToPath(new URL("../src/apply-patch.lark", import.meta.url));
const applyPatchGrammar = readFileSync(grammarPath, "utf8");
const replacedTools = ["edit", "write"] as const;
const codingAgentEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const compactionComponentUrl = new URL(
  "./modes/interactive/components/compaction-summary-message.js",
  codingAgentEntryUrl,
).href;
const { CompactionSummaryMessageComponent } = await import(compactionComponentUrl);
const editDiffUrl = new URL("./core/tools/edit-diff.js", codingAgentEntryUrl).href;
const { generateDiffString } = await import(editDiffUrl);
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
const CODEX_WEB_SEARCH_TOOL = {
  type: "web_search",
  external_web_access: true,
} as const;
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
    CompactionSummaryMessageComponent.prototype as PatchableCompactionComponent;
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

function isOpenAICodexModel(model: Model<any> | undefined): boolean {
  return model?.provider === "openai-codex";
}

function isCodexSolModel(model: Model<any> | undefined): boolean {
  return isOpenAICodexModel(model) && model?.id === "gpt-5.6-sol";
}

function supportsCodexFastMode(model: Model<any> | undefined): boolean {
  return isOpenAICodexModel(model) && CODEX_FAST_MODE_MODELS.has(model?.id ?? "");
}

function installCodexWebSearch(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const body = payload as { tools?: unknown };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (
    tools.some(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        (tool as { type?: unknown }).type === CODEX_WEB_SEARCH_TOOL.type,
    )
  ) {
    return payload;
  }

  body.tools = [...tools, { ...CODEX_WEB_SEARCH_TOOL }];
  return payload;
}

function codexAutoCompactLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9);
}

// pi compacts when usage > (window - reserve), while Codex compacts when
// usage >= auto_compact_token_limit. The extra token aligns the first trigger.
function codexCompactionReserve(contextWindow: number): number {
  return contextWindow - codexAutoCompactLimit(contextWindow) + 1;
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

type ApplyPatchDetails = {
  patch: string;
  output: string;
  changedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
};

function isCodexModel(model: Model<any> | undefined): boolean {
  return model?.provider === "openai-codex" || /(?:^|[-_.])codex(?:$|[-_.])/.test(model?.id ?? "");
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

function continueAfterSteeringMessage(text: string): string {
  return [
    "<steering-message>",
    "Treat this as an update to the current task.",
    "Only abandon, stop, or replace the previous work if this message explicitly requests that.",
    "",
    text,
    "</steering-message>",
  ].join("\n");
}

function collapseSteeringMessages(text: string): string {
  const blocks = [
    ...text.matchAll(
      /<steering-message>\nTreat this as an update to the current task\.\nOnly abandon, stop, or replace the previous work if this message explicitly requests that\.\n\n([\s\S]*?)\n<\/steering-message>/g,
    ),
  ];
  if (blocks.length < 2) return text;

  let remainder = text;
  for (const block of blocks) remainder = remainder.replace(block[0], "");
  remainder = remainder.trim();
  if (remainder) return text;

  return continueAfterSteeringMessage(
    blocks.map((block) => block[1]).join("\n\n"),
  );
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
  let applyPatchSelected: boolean | undefined;
  let retryTurnState: string | undefined;
  let fastModeEnabled = true;
  const removedForCodex = new Set<string>();

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
    fastModeEnabled = saved?.data.enabled ?? true;
  }

  function updateFastModeStatus(ctx: any) {
    if (!ctx.hasUI) return;
    const visible = fastModeEnabled && supportsCodexFastMode(ctx.model);
    ctx.ui.setStatus(
      CODEX_FAST_MODE_STATUS,
      visible ? ctx.ui.theme.fg("accent", "fast") : undefined,
    );
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

  pi.registerTool({
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

      if (result.code !== 0) {
        throw new Error(output || `Codex apply_patch exited with status ${result.code}`);
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
        content: [{ type: "text", text: output || "Patch applied successfully." }],
        details: {
          patch,
          output,
          changedPaths,
          diffs,
        } satisfies ApplyPatchDetails,
      };
    },

    renderCall({ patch }, theme) {
      const paths = patch
        .split("\n")
        .map((line) => line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/)?.[1])
        .filter((path): path is string => path !== undefined);
      const summary = paths.length > 0 ? paths.join(", ") : "patch";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("muted", summary)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, { isError }) {
      const details = result.details as ApplyPatchDetails | undefined;
      const renderedDiffs = details?.diffs
        .map(
          ({ path, diff }) =>
            `${theme.fg("muted", path)}\n${renderDiff(diff, { filePath: path })}`,
        )
        .join("\n\n");
      if (renderedDiffs) return new Text(renderedDiffs, 0, 0);
      const text = details?.changedPaths.length
        ? `Updated ${details.changedPaths.join(", ")}`
        : result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
      return new Text(theme.fg(isError ? "error" : "success", text), 0, 0);
    },
  });

  // Steering is model-independent. Make an interruption additive by default
  // while preserving the user's ability to explicitly stop or replace the task.
  pi.on("input", (event) => {
    if (event.streamingBehavior !== "steer") return;
    return {
      action: "transform",
      text: continueAfterSteeringMessage(event.text),
    };
  });

  // In "all" delivery mode, pi may combine several queued steering inputs into
  // one user message. Remove the repeated instructions before model requests.
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") {
        const content = collapseSteeringMessages(message.content);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      }
      let messageChanged = false;
      const content = message.content.map((item) => {
        if (item.type !== "text") return item;
        const text = collapseSteeringMessages(item.text);
        if (text === item.text) return item;
        changed = true;
        messageChanged = true;
        return { ...item, text };
      });
      return messageChanged ? { ...message, content } : message;
    });
    if (changed) return { messages };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "openai-codex") return;

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
      tools: pi
        .getAllTools()
        .filter((tool) => pi.getActiveTools().includes(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.name === "apply_patch"
            ? {
                constrainedSampling: {
                  type: "grammar" as const,
                  variants: { openai_lark: applyPatchGrammar },
                },
              }
            : {}),
        })),
    });
    const { response, text: responseText } = await fetchRemoteCompaction(endpoint, {
      method: "POST",
      headers: buildCompactHeaders(
        auth.apiKey,
        model.headers as Record<string, string> | undefined,
        auth.headers,
      ),
      body: JSON.stringify(body),
      signal: event.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Codex remote compaction failed (${response.status}): ${responseText || response.statusText}`,
      );
    }

    const { compaction } = parseRemoteCompactionSse(responseText);
    const output = buildReplacementHistory(body.input, compaction);

    const modifiedFiles = new Set([
      ...event.preparation.fileOps.written,
      ...event.preparation.fileOps.edited,
    ]);
    const readFiles = [...event.preparation.fileOps.read].filter(
      (path) => !modifiedFiles.has(path),
    );
    const details: RemoteCompactionDetails = {
      type: "pi-codex-remote-compaction",
      version: 1,
      checkpointId,
      endpoint,
      output: output as Record<string, unknown>[],
      readFiles,
      modifiedFiles: [...modifiedFiles],
    };
    retryTurnState = event.willRetry
      ? response.headers.get("x-codex-turn-state") ?? undefined
      : undefined;

    return {
      compaction: {
        summary: checkpointMarker(checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      },
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    installCodexWebSearch(event.payload);
    if (fastModeEnabled && supportsCodexFastMode(ctx.model)) {
      (event.payload as Record<string, unknown>).service_tier = CODEX_FAST_SERVICE_TIER;
    }
    const details = latestRemoteCompaction(ctx);
    if (details) return installRemoteCheckpoint(event.payload, details);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider === "openai-codex" && retryTurnState) {
      event.headers["x-codex-turn-state"] = retryTurnState;
    }
  });

  pi.on("agent_end", () => {
    retryTurnState = undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    restoreFastMode(ctx);
    syncTools(ctx.model);
    updateFastModeStatus(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    syncTools(event.model);
    updateFastModeStatus(ctx);
  });
}

export {
  applyPatchGrammar,
  changedPathsFromOutput,
  CODEX_FAST_MODE_MODELS,
  CODEX_FAST_SERVICE_TIER,
  CODEX_SOL_AUTO_COMPACT_LIMIT,
  CODEX_SOL_CONTEXT_WINDOW,
  CODEX_SOL_RESERVE_TOKENS,
  collapseSteeringMessages,
  codexAutoCompactLimit,
  codexCompactionReserve,
  continueAfterSteeringMessage,
  installCodexWebSearch,
  installCompactCompactionRenderer,
  isCodexModel,
  isCodexSolModel,
  isOpenAICodexModel,
  pathsFromPatch,
  supportsCodexFastMode,
};
