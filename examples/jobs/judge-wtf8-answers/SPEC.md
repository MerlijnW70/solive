# Job: The judge reads ViperJS's answers exactly

Since commit 2c6537e Solive pins a ViperJS judge that compares strings unit for unit and writes string values in its output as WTF-8: a lone surrogate leaves it as three bytes from ED A0 80 to ED BF BF, a surrogate pair always as the four-byte UTF-8 form (ViperJS's `judge/src/lib.rs` header documents the wire format). The judge in packages/cli/src/viper.ts still decodes that output as UTF-8, which turns a lone surrogate into U+FFFD. Because of that, draw.ts (`viperAnswerFault`) fails every drawn ViperJS answer that holds U+FFFD, including deliveries that really return U+FFFD, and docs/judge.md tells authors so.

## Required

1. The judge decodes ViperJS's string values as WTF-8, so an answer reaches the judge exactly as the delivery returned it: a lone surrogate as that code unit, U+FFFD as U+FFFD. Bytes that are neither valid UTF-8 nor a WTF-8 surrogate triple, or a surrogate pair written as two triples, are refused as a broken output with a named reason, never decoded with replacement.
2. With exact answers, a drawn answer that is U+FFFD or holds it is judged like any other string. A drawn answer holding a lone surrogate still fails its case, as the published-case rules require (`answerFault`), now because it was reported exactly rather than because it might have changed. `viperAnswerFault` is removed if nothing else needs it.
3. docs/judge.md and docs/maintainers/judge-internals.md describe the exact decoding and drop the U+FFFD caveat.
4. Tests for each change, including: a ViperJS delivery returning U+FFFD on a drawn case reaching the checker unchanged, one returning `"\ud800"` failing as a lone surrogate, the decoder refusing a malformed byte sequence and a pair written as two triples, and a published case returning U+FFFD passing against an expected U+FFFD.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only the judge in packages/cli/src, its tests and the two judge docs. Do not change the pinned ViperJS wasm. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test fails when the judge decodes ViperJS's output with replacement again.
3. A test fails when the decoder accepts a surrogate pair written as two triples.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
