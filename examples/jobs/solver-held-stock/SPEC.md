# Job: keep inventory reserved until a fill lands

`intent-engine solve --watch` sends fills without waiting for them to land. An inventory fill (`--inventory`) sent in one tick has not yet left the solver's balance when the next tick starts. The next tick then sees the full balance, plans fills from the same tokens, and those fills fail on chain.

## Build

- A sent inventory fill reports the token account it pays from and the amount it holds back. `Report.sent` entries for inventory fills carry `holds: { account, amount }`, with `amount` equal to the fill's `required`.
- `SolverOptions` takes an optional `held(account)`, the amount still held back by earlier fills that may not have landed. `tick` treats that amount as already spent: an inventory fill is skipped with `INVENTORY_SPENT` when the live balance minus `held(account)` and minus what this tick spent is below `required`.
- `watchSolve` keeps each sent inventory fill's hold with its flight. A hold ends when its intent is no longer listed as open, when its flight ends, or when the fill failed on chain.
- The inventory quote in `intent-engine solve` reads the balance minus what is held, so it quotes nothing when the held tokens leave too little.

## Rules

- Keep every safety check the solver has today. Holds only make fills skip; they never let a fill spend more.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- No new flag. Document nothing new unless a sentence in `docs/solver.md` becomes wrong. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: a sent inventory fill reports its hold; `tick` skips a fill that held tokens leave short and fills one they leave enough for; in watch mode, a second tick does not reuse tokens a first tick's unlanded fill holds; a hold ends when the intent closes, when the flight ends, and when the fill failed on chain; route fills hold nothing.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
