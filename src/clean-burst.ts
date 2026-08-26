/**
 * Burst-style rendering for pi-codex tools, mirroring bermudis-pi-goodies'
 * clean-tui.ts: same-tool calls within one assistant message collapse into a
 * single box, results stay hidden until expanded, and an assistant message
 * always closes the open burst.
 *
 * The assistant-message boundary is what keeps the transcript chronological.
 * pi streams a message's prose before that message's tool components render;
 * a tracker without the boundary accumulates every same-tool call of an
 * entire agent run into one block displayed at the first call's position.
 *
 * State is intentionally module-local per instance (one tracker per
 * extension load). Cross-tool grouping never happens (grouping requires an
 * equal tool name), so this tracker never needs shared state with
 * clean-tui's.
 */
import { Box, Container, Text } from "@earendil-works/pi-tui";

export type BurstEntry = {
  toolCallId: string;
  toolName: string;
  args: any;
  /**
   * Assistant-message boundary: live entries count up from 1 (bumped on each
   * assistant message_start); replayed entries count down from -1 (one per
   * assistant message in the restored branch). NaN = unknown lineage — never
   * groups.
   */
  seg: number;
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
  // Adjacency + same tool within one assistant message. Live segments count
  // up, replay segments count down — the two domains can never merge. NaN
  // (unknown lineage) compares unequal to everything, so those rows render
  // solo.
  if (a.seg !== b.seg) return false;
  if (a.toolName !== b.toolName) return false;
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

  /** Wire the lifecycle handlers a tracker needs on the ExtensionAPI. */
  registerHandlers(pi: {
    on(event: string, handler: (event: any, ctx: any) => void): void;
  }): void {
    pi.on("message_start", (event) => {
      if (event?.message?.role === "assistant") this.liveSeg++;
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
   * Rebuild replay segmentation from a restored session branch: every
   * assistant message's tool calls get one segment, mirroring the live rule.
   * Replay fires no events, so this is the only boundary source for history.
   */
  reset(branch: readonly any[]): void {
    this.liveSeg = 0;
    this.replaying = true;
    this.entries.length = 0;
    this.byId.clear();
    this.invalidates.clear();
    this.replaySegs.clear();
    let seg = 0;
    for (const entry of branch) {
      const message = entry?.type === "message" ? entry.message : undefined;
      if (message?.role !== "assistant") continue;
      seg--;
      for (const block of message.content ?? []) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          this.replaySegs.set(block.id, seg);
        }
      }
    }
  }

  /**
   * Call from renderCall. Returns the entry's burst view; the caller renders
   * an empty Container when the entry is a burst follower (the leader carries
   * the whole block). A missing toolCallId (definition-level rendering, tests)
   * renders an untracked solo view.
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
        index: -1,
      };
      return { entry: pseudo, burst: [pseudo] };
    }
    let entry = this.byId.get(toolCallId);
    if (!entry) {
      entry = {
        toolCallId,
        toolName,
        args,
        seg: this.replaying
          ? (this.replaySegs.get(toolCallId) ?? NaN)
          : this.liveSeg,
        index: this.entries.length,
      };
      this.entries.push(entry);
      this.byId.set(toolCallId, entry);
    } else {
      entry.args = args;
    }
    if (invalidate) this.invalidates.set(toolCallId, invalidate);

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
   * Call from renderResult. Records the result and revalidates the runs
   * touching this entry (an arriving result can split a burst or surface an
   * error flag on the leader). The changed row itself is NOT invalidated:
   * pi is already re-rendering it.
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
    const idx = entry.index;
    const ranges: Array<[number, number]> = [];
    if (idx > 0) ranges.push(this.runAround(idx - 1));
    if (idx + 1 < this.entries.length) ranges.push(this.runAround(idx + 1));
    const seen = new Set<number>();
    for (const [s, e] of ranges) {
      for (let i = s; i <= e; i++) {
        if (seen.has(i)) continue;
        seen.add(i);
        const fn = this.invalidates.get(this.entries[i].toolCallId);
        if (fn) fn();
      }
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
  maxLines = 12,
): string {
  const lines = text.split("\n");
  const preview = lines
    .slice(0, maxLines)
    .map((l) => theme.fg("toolOutput", l))
    .join("\n");
  let block = `\n${theme.fg("muted", `— ${label}`)}:\n${preview}`;
  const remaining = lines.length - maxLines;
  if (remaining > 0)
    block += `\n${theme.fg("muted", `... ${remaining} more lines`)}`;
  return block;
}
