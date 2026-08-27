/**
 * Burst-style rendering for pi-codex tools, mirroring bermudis-pi-goodies'
 * clean-tui.ts: same-tool calls collapse into a single box, results stay
 * hidden until expanded, and visible prose closes the open burst.
 *
 * Two boundaries keep the transcript chronological:
 *
 * - Prose segments (mirroring goodies): a segment opens when visible text
 *   appears — assistant prose or a typed user message. Textless assistant
 *   messages (thinking + tool calls only) chain into the open segment, so a
 *   model calling tools one per message still groups; the moment real prose
 *   renders, the burst closes. Without any boundary, every same-tool call of
 *   an entire agent run accumulates into one block at the first call's
 *   position.
 *
 * - Foreign-row barriers: two calls may only group when no OTHER tool row
 *   sits between them. The tracker only sees its own tools' renderCall, so
 *   it derives adjacency from the assistant message's block order: each
 *   entry records how many different-tool toolCall blocks precede it within
 *   its segment (across chained messages). Equal barriers ⟺ nothing of
 *   another tool in between, so hiding a follower can never reorder the
 *   transcript (apply_patch → read → apply_patch stays three rows).
 *
 * Extensions receive message events before pi creates the row components
 * (agent-session emits to extensions first, then to listeners), so the
 * streaming message already contains a call's block by the time its
 * renderCall runs.
 *
 * State is intentionally module-local per instance (one tracker per
 * extension load). Cross-tool grouping never happens (grouping requires an
 * equal tool name), so this tracker never needs shared state with
 * clean-tui's.
 */
import { Box, Container, Text } from "@earendil-works/pi-tui";

/**
 * A message shows visible prose when it has a non-empty text block. Thinking
 * blocks and tool calls don't count — they render as rows, not prose, and
 * must not close a burst. Mirrors goodies' clean-tui hasVisibleText.
 */
function hasVisibleText(message: any): boolean {
  return (message?.content ?? []).some(
    (b: any) =>
      b?.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length > 0,
  );
}

/**
 * Process-global flag contract with bermudis-pi-goodies/clean-tui: while the
 * flag is set, codex tools render in burst style; without it they render in
 * their standalone edit-like style. clean-tui sets the flag when it loads and
 * clears it when the feature is disabled, so /reload converges. Rendering
 * only happens after both extensions load, so the flag is always settled
 * before the first renderCall. Key is versioned — bump on any contract
 * change; the same key literal lives in goodies' clean-tui.ts.
 */
export const CLEAN_TUI_ACTIVE = Symbol.for(
  "bermudis-pi-goodies.clean-tui.active.v1",
);

export function isCleanTuiActive(): boolean {
  return (globalThis as Record<symbol, unknown>)[CLEAN_TUI_ACTIVE] === true;
}

export type BurstEntry = {
  toolCallId: string;
  toolName: string;
  args: any;
  /**
   * Prose-segment boundary (mirrors goodies' clean-tui): live entries count
   * up (bumped when visible prose appears — assistant text or a typed user
   * message); replayed entries count down from -1 (one per prose boundary in
   * the restored branch, so replay segments stay negative and can never
   * merge with live ones). NaN = unknown lineage — never groups.
   */
  seg: number;
  /**
   * Foreign-tool rows preceding this call within its segment, derived from
   * the assistant messages' block order. Two entries group only when their
   * barriers are equal — no other tool's row sits between them. NaN =
   * adjacency unprovable — never groups.
   */
  barrier: number;
  /** Position in `entries`; stable because entries are append-only. */
  index: number;
  result?: { content: Array<{ type: string; text?: string }>; details?: any };
  isError?: boolean;
  /** Content array of the last result seen; detects real mutations vs re-renders. */
  contentRef?: unknown;
};

export type BurstView = {
  entry: BurstEntry;
  /** Maximal run of groupable entries containing `entry` (same seg + tool). */
  burst: BurstEntry[];
};

export type BurstTheme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

/** Subset of pi's ToolRenderContext the tracker needs; tests may omit it. */
export type BurstRenderContext = {
  toolCallId?: string;
  invalidate?: () => void;
};

function shouldGroup(a: BurstEntry, b: BurstEntry): boolean {
  // Adjacency + same tool within one prose segment. Live segments count up,
  // replay segments count down — the two domains can never merge. Equal
  // barriers guarantee no foreign-tool row sits between the two calls, so a
  // hidden follower can never jump above an unrelated row. NaN (unknown
  // lineage or unprovable adjacency) compares unequal to everything, so
  // those rows render solo.
  if (a.seg !== b.seg) return false;
  if (a.toolName !== b.toolName) return false;
  if (a.barrier !== b.barrier) return false;
  return true;
}

/**
 * Record a tool result. pi calls renderResult on EVERY rerender of a row with
 * a fresh wrapper object; only the inner content array reference is stable.
 * Only a genuinely new result mutates state and triggers revalidation —
 * treating plain re-renders as mutations caused infinite render churn in
 * clean-tui (invalidate -> updateDisplay -> renderResult -> invalidate).
 */
export class BurstTracker {
  private entries: BurstEntry[] = [];
  private byId = new Map<string, BurstEntry>();
  private invalidates = new Map<string, () => void>();
  private liveSeg = 0;
  private replaying = true;
  private replaySegs = new Map<string, number>();
  private replayBarriers = new Map<string, number>();
  /**
   * Assistant message currently streaming (or last completed). renderCall
   * consults its block list to place foreign-row barriers; extensions get
   * message events before pi renders rows, so a call's block is always
   * present by the time its renderCall runs.
   */
  private curMessage: any = undefined;
  /** Whether the streaming assistant message has shown visible prose. */
  private curAssistantTextSeen = false;
  /**
   * Tool-call names of the assistant messages already folded into the
   * current live segment. Foreign names between two entries split them,
   * including across chained textless messages.
   */
  private segMsgNames: any[][] = [];

  /** Wire the lifecycle handlers a tracker needs on the ExtensionAPI. */
  registerHandlers(pi: {
    on(event: string, handler: (event: any, ctx: any) => void): void;
  }): void {
    pi.on("message_start", (event) => {
      const message = event?.message;
      if (!message) return;
      if (message.role === "assistant") {
        // Fold the previous assistant message's tool rows into the segment
        // ledger, then open a new segment if this message carries prose.
        if (this.curMessage)
          this.segMsgNames.push(this.messageToolCallNames(this.curMessage));
        this.curMessage = message;
        this.curAssistantTextSeen = hasVisibleText(message);
        if (this.curAssistantTextSeen) {
          this.liveSeg++;
          this.segMsgNames = [];
        }
      } else if (message.role === "user" && hasVisibleText(message)) {
        // A typed user message is prose; it must split the surrounding
        // bursts (mirrors goodies' clean-tui).
        this.liveSeg++;
        this.segMsgNames = [];
      }
    });
    pi.on("message_update", (event) => {
      const message = event?.message;
      if (message?.role !== "assistant") return;
      this.curMessage = message;
      if (!this.curAssistantTextSeen && hasVisibleText(message)) {
        // Prose streamed mid-message: close the open burst. Extensions see
        // message_update before pi renders the message's tool rows, and text
        // precedes tool calls, so this has fired before the first renderCall.
        this.curAssistantTextSeen = true;
        this.liveSeg++;
        this.segMsgNames = [];
      }
    });
    pi.on("message_end", (event) => {
      // Final content — covers rows pi creates after streaming (the
      // tool_execution_start fallback path).
      const message = event?.message;
      if (message?.role === "assistant") this.curMessage = message;
    });
    pi.on("agent_start", () => {
      // First live run after startup/resume: calls from here on may group.
      this.replaying = false;
    });
    pi.on("session_start", (_event, ctx) => {
      this.reset(ctx?.sessionManager?.getBranch?.() ?? []);
    });
  }

  /**
   * Rebuild replay segmentation from a restored session branch with the same
   * rules as the live path: visible prose opens a segment (counted down, so
   * replay segments stay negative and disjoint from live ones), textless
   * assistant messages chain, and each call records the foreign-tool rows
   * preceding it within its segment. Replay fires no events, so this is the
   * only boundary source for history.
   */
  reset(branch: readonly any[]): void {
    this.liveSeg = 0;
    this.replaying = true;
    this.entries.length = 0;
    this.byId.clear();
    this.invalidates.clear();
    this.replaySegs.clear();
    this.replayBarriers.clear();
    this.curMessage = undefined;
    this.curAssistantTextSeen = false;
    this.segMsgNames = [];
    let seg = -1;
    let segNames: any[][] = [];
    for (const entry of branch) {
      const message = entry?.type === "message" ? entry.message : undefined;
      if (!message) continue;
      if (message.role === "assistant") {
        if (hasVisibleText(message)) {
          seg--;
          segNames = [];
        }
        const names: any[] = [];
        for (const block of message.content ?? []) {
          if (block?.type !== "toolCall" || typeof block.id !== "string")
            continue;
          let barrier = 0;
          for (const prev of segNames)
            for (const name of prev)
              if (name !== block.name) barrier++;
          for (const name of names)
            if (name !== block.name) barrier++;
          this.replaySegs.set(block.id, seg);
          this.replayBarriers.set(block.id, barrier);
          names.push(block.name);
        }
        if (names.length) segNames.push(names);
      } else if (message.role === "user" && hasVisibleText(message)) {
        seg--;
        segNames = [];
      }
    }
  }

  /** Tool-call names of an assistant message, in content order. */
  private messageToolCallNames(message: any): any[] {
    const names: any[] = [];
    for (const block of message?.content ?? []) {
      if (block?.type === "toolCall") names.push(block.name);
    }
    return names;
  }

  /**
   * Foreign-tool rows preceding this call within its live segment: counts
   * different-tool toolCall blocks across the segment's folded messages plus
   * the ones preceding this block in the streaming message. NaN when the
   * message content is unavailable — adjacency cannot be proven, so the row
   * renders solo.
   */
  private liveBarrier(toolCallId: string, toolName: string): number {
    const content = this.curMessage?.content;
    if (!Array.isArray(content)) return NaN;
    let found = false;
    let barrier = 0;
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      if (block.id === toolCallId) {
        found = true;
        break;
      }
      if (block.name !== toolName) barrier++;
    }
    if (!found) return NaN;
    for (const names of this.segMsgNames)
      for (const name of names)
        if (name !== toolName) barrier++;
    return barrier;
  }

  /** Create or update an entry and remember its invalidation hook. */
  private upsert(
    toolCallId: string,
    toolName: string,
    args: any,
    invalidate?: () => void,
  ): BurstEntry {
    let entry = this.byId.get(toolCallId);
    if (!entry) {
      entry = {
        toolCallId,
        toolName,
        args,
        seg: this.replaying
          ? (this.replaySegs.get(toolCallId) ?? NaN)
          : this.liveSeg,
        barrier: this.replaying
          ? (this.replayBarriers.get(toolCallId) ?? NaN)
          : this.liveBarrier(toolCallId, toolName),
        index: this.entries.length,
      };
      this.entries.push(entry);
      this.byId.set(toolCallId, entry);
    } else {
      entry.args = args;
    }
    if (invalidate) this.invalidates.set(toolCallId, invalidate);
    return entry;
  }

  /**
   * Call from renderCall in default (non-clean-tui) rendering: per-entry
   * box state without burst semantics — every row renders itself, nothing
   * groups, so a follower render must not hide it or refresh a leader.
   * Upserts so recordResult keeps the box color fresh.
   */
  solo(
    toolCallId: string | undefined,
    toolName: string,
    args: any,
    invalidate?: () => void,
  ): { pending: boolean; isError: boolean } {
    if (!toolCallId) return { pending: true, isError: false };
    const entry = this.upsert(toolCallId, toolName, args, invalidate);
    return { pending: !entry.result, isError: !!entry.isError };
  }

  /**
   * Call from renderCall in burst (clean-tui) rendering. Returns the entry's
   * burst view; the caller renders an empty Container when the entry is a
   * burst follower (the leader carries the whole block). A missing toolCallId
   * (definition-level rendering, tests) renders an untracked solo view.
   */
  view(
    toolCallId: string | undefined,
    toolName: string,
    args: any,
    invalidate?: () => void,
  ): { entry: BurstEntry; burst: BurstEntry[] } | null {
    if (!toolCallId) {
      const pseudo: BurstEntry = {
        toolCallId: "",
        toolName,
        args,
        seg: NaN,
        barrier: NaN,
        index: -1,
      };
      return { entry: pseudo, burst: [pseudo] };
    }
    const entry = this.upsert(toolCallId, toolName, args, invalidate);

    const idx = entry.index;
    let start = idx;
    while (start > 0 && shouldGroup(this.entries[start - 1], entry)) start--;
    let end = idx;
    while (
      end + 1 < this.entries.length &&
      shouldGroup(entry, this.entries[end + 1])
    )
      end++;
    const burst = this.entries.slice(start, end + 1);
    if (burst.length > 1 && burst[0] !== entry) {
      // Refresh the leader's header/count. Single hop: a leader's renderCall
      // never invalidates anything, so this cannot loop.
      const lead = this.invalidates.get(burst[0].toolCallId);
      if (lead) lead();
      return null;
    }
    return { entry, burst };
  }

  /**
   * Call from renderResult. Records the result and revalidates the run's
   * leader (an arriving result surfaces pending/error state on the leader's
   * aggregated box). pi's updateDisplay invokes renderCall before
   * renderResult, so the box the leader just drew still shows the pre-result
   * state, and a single-call burst has no neighbors to refresh it — the
   * leader must be re-invalidated. When the leader IS the changed row, the
   * invalidation is deferred to a microtask: invalidating synchronously
   * re-enters updateDisplay mid-render, and the outer render then appends
   * its result a second time (standalone rows showed their output twice
   * until the next redraw). The contentRef guard turns the eventual
   * re-entry's recordResult into a no-op, so this cannot churn.
   */
  recordResult(
    toolCallId: string | undefined,
    result: any,
    isError: boolean,
  ): void {
    if (!toolCallId) return;
    const entry = this.byId.get(toolCallId);
    if (!entry || entry.contentRef === result?.content) return;
    entry.contentRef = result?.content;
    entry.result = result;
    entry.isError = isError;
    const [leaderIdx] = this.runAround(entry.index);
    const fn = this.invalidates.get(this.entries[leaderIdx].toolCallId);
    if (!fn) return;
    if (leaderIdx === entry.index) {
      // The leader is the row pi is currently rendering — defer past it.
      queueMicrotask(fn);
    } else {
      fn();
    }
  }

  /** Maximal groupable run containing entries[i] (pairwise adjacency). */
  private runAround(i: number): [number, number] {
    let start = i;
    while (
      start > 0 &&
      shouldGroup(this.entries[start - 1], this.entries[start])
    )
      start--;
    let end = i;
    while (
      end + 1 < this.entries.length &&
      shouldGroup(this.entries[end], this.entries[end + 1])
    )
      end++;
    return [start, end];
  }
}

/** The shared clean-tui box: padded, background follows pending/error state. */
export function burstBox(
  theme: BurstTheme,
  pending: boolean,
  isError: boolean,
  text: string,
): Box {
  const color = pending
    ? "toolPendingBg"
    : isError
      ? "toolErrorBg"
      : "toolSuccessBg";
  const box = new Box(1, 0, (s: string) => theme.bg(color, s));
  box.addChild(new Text(text, 0, 0));
  return box;
}

/** Followers (and untracked rows) render an empty container. */
export function emptyBurstRow(): Container {
  return new Container();
}

/** One muted bullet line for a burst follower list. */
export function burstBullet(
  theme: BurstTheme,
  label: string,
  isError?: boolean,
): string {
  const accent = theme.fg(isError ? "error" : "accent", label);
  return `  ${theme.fg("muted", "•")} ${accent}`;
}

/** Expanded burst header: `— label:` plus a line-capped preview block. */
export function burstDetailBlock(
  theme: BurstTheme,
  label: string,
  text: string,
  opts: { maxLines?: number; error?: boolean } = {},
): string {
  const maxLines = opts.maxLines ?? 12;
  const color = opts.error ? "error" : "toolOutput";
  const lines = text.split("\n");
  const preview = lines
    .slice(0, maxLines)
    .map((l) => theme.fg(color, l))
    .join("\n");
  let block = `\n${theme.fg("muted", `— ${label}`)}:\n${preview}`;
  const remaining = lines.length - maxLines;
  if (remaining > 0)
    block += `\n${theme.fg("muted", `... ${remaining} more lines`)}`;
  return block;
}
