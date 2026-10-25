# Job: The judge never passes a missing answer and never feeds the engines different strings

Audit round H14 found two faults in the judge (packages/cli/src):

- **JS-3** (packages/cli/test/hunt/js-drawn-undefined.test.ts): on a drawn case, `judgeDraw` in draw.ts takes `result.detail ?? null`, so a delivery that returns `undefined` is handed to the checker as `null`. A delivery that answers the published cases from a table and returns `undefined` everywhere else passes every draw whose checker accepts `null`, and `judge --yes` releases the escrow to it.
- **JS-1** (packages/cli/test/hunt/js-lone-surrogate.test.ts): viper.ts encodes string arguments with `Buffer.from(text, "utf8")`, which turns a lone surrogate such as `"\ud800"` into U+FFFD for viper only, while the host and node engines receive the exact string. A correct delivery then fails in viper and the judge refuses valid work, against docs/maintainers/judge-internals.md ("Every engine receives each argument exactly as the spec writes it").

## Required

1. A drawn case whose delivery returns `undefined`, or anything the engine cannot report as a value, fails that case; it is never passed to the checker as `null` or any other value. The same holds for every engine and for published cases, where it already fails.
2. A spec whose arguments or expected values contain a string that UTF-8 cannot carry exactly (a lone surrogate) is refused when the judge reads the spec, with a reason naming the case, the same way an expected `-0` is refused: the job is refused and nothing is paid. Generated draw inputs are held to the same rule. docs/judge.md and docs/maintainers/judge-internals.md say so.
3. The two hunt tests are added unchanged from their deliveries (they are in the H14 kit) and are reworked only as far as the new refusal requires: the lone-surrogate test must now show the spec refused before any engine runs, and say so in its title. Every other existing test passes.
4. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only the judge in packages/cli/src, its tests and the two judge docs. Do not change the pinned ViperJS wasm. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test fails when the judge puts `?? null` back on a drawn answer.
3. A test fails when the judge lets a spec with a lone surrogate argument through to the engines.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
