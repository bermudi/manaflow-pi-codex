# Third-party notices

## OpenAI Codex

This package includes `src/apply-patch.lark`, copied from:

- Project: OpenAI Codex
- Repository: https://github.com/openai/codex
- Source path: `codex-rs/core/src/tools/handlers/apply_patch.lark`
- Revision inspected during implementation: `8b8fa7276f3da289108512d673303eeacc5bcff3`
- License: Apache License 2.0

The runtime depends on the official `@openai/codex` npm package and invokes the native Codex binary's `--codex-run-as-apply-patch` entrypoint.

The remote compaction integration was implemented against the same revision's `codex-rs/core/src/compact_remote_v2.rs`, `codex-rs/core/src/compact_remote_v2_attempt.rs`, and `codex-rs/features/src/lib.rs`. It interoperates with the ChatGPT Codex service but does not copy those Rust sources.

Copyright OpenAI and contributors. Licensed under the Apache License, Version 2.0. You may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0.
