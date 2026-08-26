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

test("calls within one assistant message group; the next message breaks the burst", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);

  pi.emit("message_start", { message: { role: "assistant" } });
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

  // A new assistant message closes the burst — its tools render separately
  // instead of being dragged into the earlier block.
  pi.emit("message_start", { message: { role: "assistant" } });
  const c = tracker.view("c", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(c);
  assert.equal(c.burst.length, 1);
});

test("different tools never group, even in one message", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  pi.emit("message_start", { message: { role: "assistant" } });

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
  const assistantMessage = (...ids: string[]) => ({
    type: "message",
    message: {
      role: "assistant",
      content: ids.map((id) => ({
        type: "toolCall",
        id,
        name: "apply_patch",
        arguments: {},
      })),
    },
  });
  pi.emit(
    "session_start",
    {},
    {
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "user", content: [] } },
          assistantMessage("a", "b"),
          assistantMessage("c"),
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

test("a follower render refreshes the leader once and renders nothing itself", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  pi.emit("message_start", { message: { role: "assistant" } });

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

test("recordResult ignores repeated wrappers (no render churn)", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  startSession(pi);
  pi.emit("message_start", { message: { role: "assistant" } });

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

test("call lineage never merges across replay and live sessions", () => {
  const pi = fakePi();
  const tracker = new BurstTracker();
  tracker.registerHandlers(pi);
  const assistantMessage = (id: string) => ({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "apply_patch", arguments: {} }],
    },
  });
  pi.emit(
    "session_start",
    {},
    { sessionManager: { getBranch: () => [assistantMessage("a")] } },
  );
  const replayed = tracker.view("a", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(replayed);
  assert.equal(replayed.burst.length, 1);

  // A live call after the replayed one must not join it (negative replay
  // segments can never equal live segments).
  pi.emit("agent_start");
  pi.emit("message_start", { message: { role: "assistant" } });
  const live = tracker.view("b", "apply_patch", { patch: PATCH }, () => {});
  assert.ok(live);
  assert.equal(live.burst.length, 1);
});
