/**
 * Some OpenAI Responses serving paths accept additional_tools without exposing
 * those declarations to the model. Use the ordinary request-level tool list.
 * Keep the wire schemas intact: in particular, a grammar tool must stay custom.
 *
 * Pi's live loadout determines removals; later declarations determine the latest
 * schema. Never reconstruct tools from getAllTools(), which would lose prepared
 * descriptions, hidden declarations, strict schemas, and grammar metadata.
 */
export function installTopLevelResponsesTools(
  payload: unknown,
  activeToolNames: readonly string[],
): number | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
  const additions = payload.input.filter(
    (item: unknown) => isRecord(item) && item.type === "additional_tools",
  );
  if (additions.length === 0) return undefined;

  // Validate everything before mutating the request. An upstream format change
  // must be reported, not silently turn a request into one without tools.
  const batches: unknown[][] = [];
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools)) throw new Error("Responses tools must be an array");
    batches.push(payload.tools);
  }
  for (const item of additions) {
    if (!isRecord(item) || !Array.isArray(item.tools)) {
      throw new Error("Responses additional_tools must contain a tools array");
    }
    batches.push(item.tools);
  }

  const active = new Set(activeToolNames);
  const named = new Map<string, Record<string, unknown>>();
  const builtins: Record<string, unknown>[] = [];
  for (const batch of batches) {
    for (const tool of batch) {
      if (!isRecord(tool) || typeof tool.type !== "string") {
        throw new Error("Invalid Responses tool declaration");
      }
      if (typeof tool.name === "string") {
        if (active.has(tool.name)) named.set(tool.name, tool);
      } else {
        // Server tools such as web_search need not have a function name.
        builtins.push(tool);
      }
    }
  }

  payload.tools = [...builtins, ...named.values()];
  payload.input = payload.input.filter(
    (item: unknown) => !isRecord(item) || item.type !== "additional_tools",
  );
  return named.size;
}

/**
 * Enable OpenAI's hosted Responses web search on the first-party connection.
 * Pi models this extension's `web_search` as a client tool, so its tool-change
 * history can contain a "do not call web_search" notice after the client tool
 * is deactivated for an OpenAI model. The native server tool uses the same
 * name; remove only that stale removal notice while preserving other tools'
 * availability state.
 */
export function installOpenAIServerWebSearch(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
    throw new Error("Responses tools must be an array");
  }

  const declaredTools = (payload.tools ?? []) as unknown[];
  const tools = declaredTools.filter(
    (tool) => !(isRecord(tool) && tool.name === "web_search"),
  );
  const removedClientSearch = tools.length !== declaredTools.length;
  const hasWebSearch = tools.some(
    (tool) => isRecord(tool) && tool.type === "web_search",
  );
  const input = Array.isArray(payload.input)
    ? payload.input
        .map(removeWebSearchUnavailableNotice)
        .filter((message) => message !== undefined)
    : payload.input;
  if (Array.isArray(input)) addOpenAIWebSearchGuidance(input);
  payload.tools = hasWebSearch ? tools : [...tools, { type: "web_search" }];
  if (input !== undefined) payload.input = input;
  return !hasWebSearch || removedClientSearch;
}

const TOOL_REMOVAL_NOTICE =
  "The following tools are no longer available. Do not call them:";
const OPENAI_WEB_SEARCH_GUIDANCE =
  "For current, niche, or source-dependent information, use OpenAI's hosted web_search tool and cite its sources. Prefer it over MCP web-search tools unless a specialized source or integration is needed.";

function addOpenAIWebSearchGuidance(input: unknown[]): void {
  if (
    input.some(
      (message) =>
        isRecord(message) &&
        message.role === "developer" &&
        message.content === OPENAI_WEB_SEARCH_GUIDANCE,
    )
  ) {
    return;
  }

  const firstUserMessage = input.findIndex(
    (message) => isRecord(message) && message.role === "user",
  );
  input.splice(
    firstUserMessage === -1 ? input.length : firstUserMessage,
    0,
    { role: "developer", content: OPENAI_WEB_SEARCH_GUIDANCE },
  );
}

function removeWebSearchUnavailableNotice(message: unknown): unknown {
  if (
    !isRecord(message) ||
    (message.role !== "developer" && message.role !== "system")
  ) {
    return message;
  }

  if (typeof message.content === "string") {
    const content = restoreWebSearchAvailability(message.content);
    if (content === message.content) return message;
    return content.length > 0 ? { ...message, content } : undefined;
  }
  if (!Array.isArray(message.content)) return message;

  let changed = false;
  const content = message.content.map((part: unknown) => {
    if (!isRecord(part) || typeof part.text !== "string") return part;
    const text = restoreWebSearchAvailability(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  }).filter((part: unknown) => {
    return !isRecord(part) || typeof part.text !== "string" || part.text.length > 0;
  });
  if (!changed) return message;
  return content.length > 0 ? { ...message, content } : undefined;
}

function restoreWebSearchAvailability(text: string): string {
  let result = text;
  let changed = false;
  const paragraphs = result.split("\n\n");
  const restored = paragraphs.map((paragraph) => {
    if (!paragraph.startsWith(`${TOOL_REMOVAL_NOTICE}\n`)) return paragraph;
    const names = paragraph
      .slice(TOOL_REMOVAL_NOTICE.length + 1)
      .split("\n")
      .map((line) => (line.startsWith("- ") ? line.slice(2) : undefined));
    if (names.some((name) => name === undefined) || !names.includes("web_search")) {
      return paragraph;
    }
    changed = true;
    const remaining = names.filter(
      (name): name is string => name !== undefined && name !== "web_search",
    );
    return remaining.length > 0
      ? `${TOOL_REMOVAL_NOTICE}\n${remaining.map((name) => `- ${name}`).join("\n")}`
      : "";
  });
  result = restored.filter(Boolean).join("\n\n");

  // Incremental tool notices use a compact comma-separated unavailable list
  // rather than the full removal notice above.
  result = result.replace(/Still unavailable: ([^\n.]+)\./g, (_notice, list: string) => {
    const names = list
      .split(",")
      .map((name) => name.trim());
    if (!names.includes("web_search")) return _notice;
    changed = true;
    const remaining = names.filter((name) => name.length > 0 && name !== "web_search");
    return remaining.length > 0 ? `Still unavailable: ${remaining.join(", ")}.` : "";
  });
  // Separator cleanup is only justified when a notice was actually edited.
  // Otherwise preserve the original prompt, including whitespace, verbatim.
  if (!changed) return text;
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Pi's OpenAI Responses parser currently keeps output text but drops its
 * `url_citation` annotations. Add a compact, clickable sources list before the
 * parser consumes `response.output_item.done`, so hosted-search sources remain
 * visible in the assistant message and its saved transcript.
 */
export function appendOpenAIWebSearchCitationSources(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "response.output_item.done") return false;
  const item = event.item;
  if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
    return false;
  }

  const citations = new Map<string, string>();
  let finalTextItem: Record<string, unknown> | undefined;
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== "output_text") continue;
    finalTextItem = part;
    if (!Array.isArray(part.annotations)) continue;
    for (const annotation of part.annotations) {
      if (
        !isRecord(annotation) ||
        annotation.type !== "url_citation" ||
        typeof annotation.url !== "string"
      ) {
        continue;
      }
      let url: URL;
      try {
        url = new URL(annotation.url);
      } catch {
        continue;
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        continue;
      }
      const title =
        typeof annotation.title === "string" && annotation.title.trim().length > 0
          ? annotation.title.trim()
          : url.hostname;
      if (!citations.has(url.toString())) citations.set(url.toString(), title);
    }
  }

  if (!finalTextItem || citations.size === 0) return false;
  const currentText =
    typeof finalTextItem.text === "string" ? finalTextItem.text : "";
  if (currentText.includes("\n\nSources:\n")) return false;

  const sources = [...citations].map(([url, title]) => {
    const label = title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
    const href = url.replace(/[\[\]()\\]/g, (character) => {
      if (character === "(") return "%28";
      if (character === ")") return "%29";
      if (character === "[") return "%5B";
      if (character === "]") return "%5D";
      return "%5C";
    });
    return `- [${label}](${href})`;
  });
  finalTextItem.text = `${currentText.trimEnd()}\n\nSources:\n${sources.join("\n")}`;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
