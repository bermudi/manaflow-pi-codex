import assert from "node:assert/strict";
import test from "node:test";
import {
  BurstTracker,
  CLEAN_TUI_ACTIVE,
  isCleanTuiActive,
} from "../src/clean-burst.ts";

type Handler = (event: any, ctx: any) => void;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, eventData?: any, ctx?: any) {
      for (const handler of handlers.get(event) ?? []) handler(eventData, ctx);
    },
  };
  return pi;
}

test("isCleanTuiActive follows the goodies integration flag", () => {
  const globals = globalThis as Record<symbol, unknown>;
  delete globals[CLEAN_TUI_ACTIVE];
  assert.equal(isCleanTuiActive(), false);
  globals[CLEAN_TUI_ACTIVE] = true;
  assert.equal(isCleanTuiActive(), true);
  delete globals[CLEAN_TUI_ACTIVE];
  assert.equal(isCleanTuiActive(), false);
});

const PATCH = "*** Begin Patch\n*** Add File: x.ts\n+x\n*** End Patch";

function startSession(
  pi: ReturnType<typeof fakePi>,
  branch: readonly any[] = [],
) {
  pi.emit("session_start", {}, { sessionManager: { getBranch: () => branch } });
  pi.emit("agent_start");
}

function toolCall(id: string, name = "apply_patch") {
  return { type: "toolCall", id, name, arguments: {} };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function startAssistantMessage(
  pi: ReturnType<typeof fakePi>,
  content: any[],
) {
  pi.emit("message_start", { message: { role: "assistant", content } });
}

test("calls within one assistant message group; prose closes the burst", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);

  startAssistantMessage(pi, [toolCall("a"), toolCall("b")]);
  const a = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(a);
  assert.equal(a.burst.length, 1); // rendered before b arrives
  // b joins a's burst as a follower: view() returns null and pi renders
  // nothing for it (the leader carries the whole block).
  assert.equal(
    tracker.view("b", "apply_patch", { patch: PATCH }, () => {}),
    null,
  );
  // The leader re-renders after each follower lands (single-hop invalidation).
  const aAgain = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(aAgain);
  assert.equal(aAgain.burst.length, 2);

  // Visible prose closes the burst — its tools render separately instead of
  // being dragged into the earlier block.
  startAssistantMessage(pi, [textBlock("Done."), toolCall("c")]);
  const c = tracker.view("c", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(c);
  assert.equal(c.burst.length, 1);
});

test("textless assistant messages chain into one burst until prose appears", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);

  startAssistantMessage(pi, [toolCall("a")]);
  assert.ok(tracker.view("a", "apply_patch", { patch: PATCH }, () => {}));
  // No prose between messages: b chains into a's burst (mirrors goodies).
  startAssistantMessage(pi, [toolCall("b")]);
  assert.equal(
    tracker.view("b", "apply_patch", { patch: PATCH }, () => {}),
    null,
  );
  // A typed user message is prose too — it closes the chain.
  pi.emit("message_start", {
    message: { role: "user", content: [textBlock("again")] },
  });
  startAssistantMessage(pi, [toolCall("c")]);
  const c = tracker.view("c", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(c);
  assert.equal(c.burst.length, 1);
});

test("an untracked tool row between two calls splits the burst", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);

  startAssistantMessage(pi, [toolCall("a"), toolCall("r", "read"), toolCall("b")]);
  const a = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(a);
  assert.equal(a.burst.length, 1);
  // b must render its own row: hiding it as a's follower would visually move
  // it above the intervening read.
  const b = tracker.view("b", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(b);
  assert.equal(b.burst.length, 1);
});

test("same-tool calls after a foreign row still group with each other", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);

  startAssistantMessage(pi, [toolCall("r", "read"), toolCall("a"), toolCall("b")]);
  const a = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(a);
  assert.equal(a.burst.length, 1);
  assert.equal(
    tracker.view("b", "apply_patch", { patch: PATCH }, () => {}),
    null,
  );
  const aAgain = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(aAgain);
  assert.equal(aAgain.burst.length, 2);
});

test("a foreign row in a chained textless message splits cross-message bursts", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);

  startAssistantMessage(pi, [toolCall("a")]);
  assert.ok(tracker.view("a", "apply_patch", { patch: PATCH }, () => {}));
  // The read row renders between a and b even though no prose separates them.
  startAssistantMessage(pi, [toolCall("r", "read"), toolCall("b")]);
  const b = tracker.view("b", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(b);
  assert.equal(b.burst.length, 1);
});

test("different tools never group, even in one message", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  startAssistantMessage(pi, [toolCall("a"), toolCall("b", "web_search")]);

  const a = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  const b = tracker.view(
    "b",
    "web_search",
    { search_query: [{ q: "x" }] },
    () => {},
  );
  assert.ok(a && b);
  assert.equal(a.burst.length, 1);
  assert.equal(b.burst.length, 1);
});

test("replay segmentation is rebuilt from the session branch", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  const assistantMessage = (...content: any[]) => ({
    type: "message",
    message: { role: "assistant", content },
  });
  pi.emit(
    "session_start",
    {},
    {
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "user", content: [] } },
          assistantMessage(toolCall("a"), toolCall("b")),
          assistantMessage(textBlock("Done."), toolCall("c")),
        ],
      },
    },
  );

  const a = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(a);
  // b is a's burst follower: nothing renders for it, and the leader's
  // re-render picks it up.
  assert.equal(
    tracker.view("b", "apply_patch", { patch: PATCH }, () => {}),
    null,
  );
  const aAgain = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(aAgain);
  assert.equal(aAgain.burst.length, 2);
  const c = tracker.view("c", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(c);
  assert.equal(c.burst.length, 1);
});

test("replay splits bursts at foreign tool rows", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  pi.emit(
    "session_start",
    {},
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [toolCall("a"), toolCall("r", "read"), toolCall("b")],
            },
          },
        ],
      },
    },
  );

  const a = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(a);
  assert.equal(a.burst.length, 1);
  const b = tracker.view("b", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(b);
  assert.equal(b.burst.length, 1);
});

test("replayed calls never merge with live ones", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  const replayedMessage = {
    type: "message",
    message: {
      role: "assistant",
      content: [toolCall("a")],
    },
  };
  pi.emit(
    "session_start",
    {},
    { sessionManager: { getBranch: () => [replayedMessage] } },
  );
  const replayed = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(replayed);
  assert.equal(replayed.burst.length, 1);

  // A live call after the replayed one must not join it (replay segments
  // stay negative; live segments start at zero).
  pi.emit("agent_start");
  startAssistantMessage(pi, [toolCall("b")]);
  const live = tracker.view("b", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(live);
  assert.equal(live.burst.length, 1);
});

test("a follower render refreshes the leader once and renders nothing itself", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  startAssistantMessage(pi, [toolCall("a"), toolCall("b")]);

  let leaderInvalidations = 0;
  tracker.view(
    "a",
    "apply_patch",
    { patch: PATCH },
    () => leaderInvalidations++,
  );
  const follower = tracker.view("b", "apply_patch", { patch: PATCH }, () => {
    throw new Error("follower should not be invalidated");
  });
  assert.equal(follower, null);
  assert.equal(leaderInvalidations, 1);
});

test("a single-call burst refreshes its own box when the result arrives", async () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  startAssistantMessage(pi, [toolCall("a")]);

  let invalidations = 0;
  tracker.view("a", "apply_patch", { patch: PATCH }, () => invalidations++);
  assert.equal(invalidations, 0);
  // No neighbors exist to refresh the leader, so the leader (the entry
  // itself) must be invalidated or its pending background never clears.
  // The invalidation is deferred past pi's in-flight render.
  tracker.recordResult(
    "a",
    { content: [{ type: "text", text: "ok" }] },
    false,
  );
  assert.equal(invalidations, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidations, 1);
});

test("recordResult ignores repeated wrappers (no render churn)", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  startAssistantMessage(pi, [toolCall("a"), toolCall("b")]);

  let invalidations = 0;
  tracker.view("a", "apply_patch", { patch: PATCH }, () => invalidations++);
  tracker.view("b", "apply_patch", { patch: PATCH }, () => invalidations++);
  const content = [{ type: "text", text: "ok" }];
  const result = { content, details: {} };
  tracker.recordResult("b", result, false);
  const afterFirst = invalidations;
  // pi re-renders rows with a fresh wrapper but a stable content array;
  // only a new content array may revalidate.
  tracker.recordResult("b", { content, details: {} }, false);
  assert.equal(invalidations, afterFirst);
  tracker.recordResult(
    "b",
    { content: [{ type: "text", text: "changed" }], details: {} },
    false,
  );
  assert.ok(invalidations > afterFirst);
});
