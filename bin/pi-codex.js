#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userArgs = process.argv.slice(2);

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const provider = optionValue(userArgs, "--provider");
const model = optionValue(userArgs, "--model");
const modelHasProvider = model?.includes("/") ?? false;
const defaults = provider || modelHasProvider ? [] : ["--provider", "openai-codex"];
const child = spawn("pi", ["-e", packageRoot, ...defaults, ...userArgs], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`pi-codex: failed to launch pi: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
