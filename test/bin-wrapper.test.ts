import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

/**
 * The published `pi-codex` bin spawns `pi` from PATH. A fake `pi` on an
 * isolated PATH records its arguments and exits the way the test asks, so
 * the wrapper's argument defaults and exit propagation run for real.
 */
const wrapper = join(import.meta.dirname, "..", "bin", "pi-codex.js");
const posix = process.platform !== "win32";

async function runWrapper(mode: string, args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-bin-test-"));
  try {
    const argsFile = join(dir, "args.txt");
    const fake = join(dir, "pi");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$FAKE_PI_ARGS"',
        'case "$FAKE_PI_MODE" in',
        "  sigterm) kill -TERM $$ ;;",
        "  code3) exit 3 ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    const child = spawn(process.execPath, [wrapper, ...args], {
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_PI_MODE: mode,
        FAKE_PI_ARGS: argsFile,
      },
      stdio: "ignore",
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
    );
    const passed = (await readFile(argsFile, "utf8")).split("\n").filter(Boolean);
    return { code, signal, passed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("pi-codex defaults the provider and passes the exit code through", { skip: !posix }, async () => {
  const ok = await runWrapper("ok", ["--model", "gpt-5.6-sol"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.passed[0], "-e");
  assert.deepEqual(ok.passed.slice(2), ["--provider", "openai-codex", "--model", "gpt-5.6-sol"]);

  const explicit = await runWrapper("ok", ["--model", "anthropic/claude-sonnet-4-6"]);
  assert.deepEqual(explicit.passed.slice(2), ["--model", "anthropic/claude-sonnet-4-6"]);

  // pi (1.3.0 and 1.4.0) rejects --provider without --model, so a run
  // without a model must not get the provider default.
  const bare = await runWrapper("ok", []);
  assert.equal(bare.passed[0], "-e");
  assert.deepEqual(bare.passed.slice(2), []);

  const failed = await runWrapper("code3", []);
  assert.equal(failed.code, 3);
});

test("pi-codex re-raises the signal that terminated pi", { skip: !posix }, async () => {
  const killed = await runWrapper("sigterm", []);
  assert.equal(killed.signal, "SIGTERM", `wrapper exited with code ${killed.code} instead of the signal`);
  assert.equal(killed.code, null);
});
