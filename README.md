# pi-codex

A [pi](https://pi.dev) package maintained by [bermudi](https://github.com/bermudi), forked from [Manaflow](https://github.com/manaflow-ai)
that gives Codex models OpenAI Codex's native `apply_patch` and web search tools.

When the selected model uses the `openai-codex` provider, its model ID contains `codex`, or it is a `deepseek-v4` model (trained on the Codex harness), the extension replaces active `edit` and `write` tools with `apply_patch`. Switching to any other model restores the tools it removed.

## Install

Install [pi](https://pi.dev), then install this package directly from GitHub:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install git:github.com/bermudi/manaflow-pi-codex
pi
```

Use `/login` to authenticate with ChatGPT, then select an `openai-codex` model
with `/model`. To pin this release instead of following the default
branch:

```bash
pi install git:github.com/bermudi/manaflow-pi-codex@v0.1.3
```

> The unscoped `pi-codex` package on npm is an unrelated project. Install this
> package from GitHub as shown above.

Pi packages execute code with your user permissions. Review the source before
installing it.

## Why the Codex dependency?

The model-facing tool does not require a provider workaround. Pi supports OpenAI custom/freeform tools with Lark grammars, and pi's Codex model catalog enables that capability.

Applying a patch correctly is separate. This package pins `@openai/codex` and invokes its native binary's internal `apply_patch` entrypoint, so parsing, fuzzy context matching, file moves, errors, and output match the upstream implementation instead of a partial TypeScript rewrite.

## Launcher

The package also includes a `pi-codex` launcher that loads the extension for
one run and defaults pi to the `openai-codex` provider. Install it from a
checkout:

```bash
git clone https://github.com/bermudi/manaflow-pi-codex.git
cd pi-codex
npm install
npm link
pi-codex
```

The launcher loads this package and defaults pi to the `openai-codex` provider. Normal pi arguments work:

```bash
pi-codex --model gpt-5.6-sol:high
pi-codex --model openai/gpt-5.3-codex
```

To install only the extension into pi without the launcher:

```bash
pi install git:github.com/bermudi/manaflow-pi-codex
```

The native Codex package is large because it includes the platform binary.

## Behavior

- Uses the upstream freeform patch format and Lark grammar.
- Keeps each registered tool's TypeBox schema, exposure, execution mode,
  capabilities, and output budget in one Codex tool contract. Remote
  compaction sends the same direct model-visible schema projection as the
  active Pi tools, while preserving deferred-loading metadata for discovery.
- Supports add, update, move, and delete hunks.
- Executes patches sequentially relative to other tool calls.
- Respects tool selection: if `apply_patch` was excluded initially, `edit` and `write` are not replaced.
- Falls back to pi's normal `edit` and `write` tools after switching away from a Codex model.
- Enables Codex's standalone live `web_search` tool for the `openai-codex` provider. Rendering adapts: standalone (or with goodies' clean-tui disabled) it renders like pi's native tool rows with the search output visible; with bermudis-pi-goodies' clean-tui enabled it renders as a clean burst row (same-tool calls share one block; output hidden until the row is expanded).
- Sends standalone search to the resolved Codex `/alpha/search` endpoint, preserving provider base URL and header overrides.
- Uses current Codex remote compaction V2 for the `openai-codex` provider.
- Applies Codex's model-facing middle-output truncation policy to package
  tools and the `tool_result` boundary, while retaining raw search output and
  patch details for rendering and inspection. Structured non-text result
  content remains attached to the truncated model-facing result.
- Applies Codex Fast mode (`service_tier: "priority"`) when enabled for models that advertise the Fast tier, covering both normal turns and remote-compaction turns. Fast mode defaults to off (see `/fast` below).
- Renders `apply_patch` like pi's native edit row (colored diffs visible) by default; with bermudis-pi-goodies' clean-tui enabled it renders as a clean burst row — collapsed header shows the touched paths, `Ctrl+O` expands to pi-native colored diffs generated from the actual before/after files.
- Collapses the normal compaction notice to one line; `Ctrl+O` still expands its summary.
- Keeps Pi's normal working spinner and adds a once-per-second elapsed-time
  label (`Working (12s)`, `Working (1m 5s)`) to the working row.

## Remote compaction

Current OpenAI Codex enables `RemoteCompactionV2` by default. `pi-codex` mirrors that flow:

1. Sends a streaming request to the resolved Codex provider base URL plus `/codex/responses` (normally `https://chatgpt.com/backend-api/codex/responses`), the same route as normal turns. Auth-provided base URL overrides are honored.
2. Appends `{ "type": "compaction_trigger" }` to the Responses input.
3. Requires exactly one `{ "type": "compaction" }` output item.
4. Persists the opaque replacement history in pi's compaction entry and reinstalls it verbatim in later Codex requests, including after resume.
5. Stores the response ID, token usage, tool-catalog fingerprint, retained
   suffix fingerprint, and checkpoint version with the replacement history. A
   v2 checkpoint is replayed only when its marker, active tool catalog, and
   retained suffix still match; legacy v1 entries remain readable.
6. Replays `x-codex-turn-state` only within the active Pi turn, including an
   immediate overflow retry.

Automatic compaction runs between tool results and the next reply within the same agent run on pi ≥ 0.84.4, so long tool loops compact before the next model request instead of only after the run settles. Older pi versions check only after the run ends and can overshoot the window mid-loop.

For every model under the `openai-codex` provider, `pi-codex` matches Codex's default automatic-compaction boundary at 90% of that model's context window. For example, the live 272,000-token models compact beginning at 244,800 tokens, while the 128,000-token Spark model begins at 115,200. Internally the pi reserve includes one extra token because pi's comparison is `>` while Codex's is `>=`. The override is in-memory, applies only while an `openai-codex` model is selected, preserves an explicit `compaction.enabled: false`, and does not rewrite `settings.json` or affect other providers.

The older `/codex/responses/compact` endpoint remains in Codex for the legacy implementation, but it is not the default in the inspected upstream revision. There is no additional compaction-specific subrouter path: both normal and compaction V2 traffic use the resolved base URL's `/backend-api/codex/responses` route.

Remote compaction is intentionally limited to the `openai-codex` provider. The built-in `openai` provider's Responses connection uses the server-side compaction flow below; all other providers retain pi's normal local summary compaction.

## Server-side compaction (openai connection)

For pi's built-in `openai` provider using the Responses API (`api: "openai-responses"`) at the first-party `https://api.openai.com/v1` base URL, `pi-codex` asks OpenAI to compact the conversation server-side instead of letting pi's local summary run first:

- Server compaction is on by default only for the probed model family: live requests carrying `context_management` were accepted by `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, and `gpt-6.1-sol` on the first-party connection. Pre-GPT-6 catalog models (`gpt-4.1`, `o3`, `o4-mini`, `gpt-5.x`, ...) are rejected by that connection at the model level, so their `context_management` acceptance is unverified and they stay on pi's local compaction. Any other model opts in with `compat.supportsServerCompaction: true` (or the top-level `supportsServerCompaction: true`); every model can opt out with `false`.
- Each request carries `context_management: [{ "type": "compaction", "compact_threshold": <90% of the model context window> }]` unless the request already has `context_management`. The threshold is floored and clamped to the API minimum of 1000; a 272,000-token window uses 244,800.
- The final compaction item from the response stream (`response.output_item.done`, falling back to the last compaction item in `response.completed`) is persisted as a `pi-codex-server-compaction` checkpoint together with its token usage. Later requests replace the checkpoint marker in the input with that opaque item exactly once; missing, duplicated, or stale markers are ignored.
- Checkpoint repair runs first, before anything capability-gated: a model-level opt-out, a proxy base URL, a failed auth lookup, or a settings-read failure can never send the raw marker instead of the checkpoint — the marker is a placeholder with no conversation content. Only *new* server compaction (the `context_management` parameter and the threshold suppression below) is gated on the connection being eligible. Branch summaries are additive context on the active path, so repair continues past them to the checkpoint that precedes the branch point.
- The checkpoint is committed through pi's `turn_end` boundary drafts, not by calling `SessionManager.appendCompaction` directly. Pi therefore emits `entry_appended` for the checkpoint, so the interactive transcript, compaction notice, and footer update normally.
- Output emitted before the compaction item was already folded into the checkpoint. Pi aggregates the whole response into one assistant message, so the extension adds an append-only `context_edit` that retains only the post-checkpoint suffix. Tool results stay in model context, including results whose calls the checkpoint absorbed: the server retains those calls inside the opaque item, and only items before the newest compaction may be pruned. Without the assistant edit, the next request would contain the checkpoint followed by output it already covers (`C → A → B` instead of `C → B`).
- pi's local compaction threshold is suppressed for this connection by returning `reserveTokens: 0` from the in-memory settings patch, so the server's 90% threshold gets the crossing request. Overflow recovery still force-compacts because it is independent of the reserve; the configured reserve is restored for that local summary path.

`/compact` on this connection remains pi-local summarization. The extension restores the configured reserve for that path so the local summary has a usable output budget. If a server checkpoint already exists, pi's local summarizer sees only the opaque marker as its previous summary and summarizes the retained tail. The extension keeps the older checkpoint item ahead of that new local summary at request time, so a local compaction cannot silently drop the checkpointed prefix.

Caveats:

- The context meter under-reports the effective context after a server compaction: pi sees the marker/opaque item, not the server's compressed token count. The `context_edit` still removes pre-checkpoint assistant output from pi's estimate.
- Server items are tied to the model and account that produced them. Switching models after a server compaction is not supported by this path: the request still carries the checkpoint on the openai Responses connection, and the extension prints one stderr notice per checkpoint — switch back to the producing model or start a new session. Connections that cannot carry the opaque Responses item at all (the Codex provider, other providers) leave the request untouched and print the same style of notice instead of silently sending the marker text.
- Proxy or auth-overridden base URLs (anything other than `https://api.openai.com/v1`) skip *new* server compaction; an existing checkpoint is still repaired on the proxied connection rather than silently replaced by the marker text. A model may opt out entirely with `compat.supportsServerCompaction: false`.
- The 2026-10-23 capability probe ran on the ChatGPT-plan OAuth connection; API-key mode is assumed to have the same Responses behavior, but that path has not been live-tested.
- Requires pi >= 0.99.0 (`provider_stream_event`, `turn_end` boundary drafts, and `SessionManager.appendCompaction`). An unparsable host version is treated as unsupported. Without these capabilities the extension logs one notice and leaves the request untouched.
- Provider-auth lookup failures and settings-read failures are surfaced to pi's extension error boundary instead of being treated as “no override” or “compaction enabled.” A request is not silently enabled or disabled on a failed read, and an active server mode is cleared so the local threshold is never left suppressed by a failed read or auth lookup.

The package targets pi's extension APIs and is developed against Pi 1.3. It does not attempt to reproduce Codex's
subagent tool surface yet. First-class namespace routing, model-owned tool
search dispatch, and provider response continuation remain Pi core concerns.
Deferred contracts therefore stay out of the initial model-visible tool list,
matching Codex's `model_visible_specs()` projection, while their schemas remain
available to the tool-search lifecycle and checkpoint fingerprint.

## Fast mode

Fast mode defaults to off for supported `openai-codex` models. Use:

```text
/fast          # toggle
/fast on
/fast off
/fast status
```

The selection is stored in the session, survives `/reload` and resume, and resets to off for a new session. Unsupported models and non-Codex providers ignore the tier selection.

## Development

```bash
npm install
npm run check
npm test
```

The upstream grammar is copied from `codex-rs/core/src/tools/handlers/apply_patch.lark` in `openai/codex`. See `THIRD_PARTY_NOTICES.md`.
