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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
