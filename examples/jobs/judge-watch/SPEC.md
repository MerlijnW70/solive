# Job: a judge that runs on its own

`intent-engine judge` checks one delivery when a person starts it. An agent that posts a job has to come back and run it again for every new delivery.

## Build

- `intent-engine judge --watch` takes the same options as `judge` for one escrow, and keeps running.
- Every `--interval` seconds (default 30) it reads the escrow's deliveries. It judges each new announced hash once, in announcement order, with the same check and sandbox `judge` uses.
- On the first pass it settles, when `--yes` is given, and exits 0. A failed delivery is never judged again.
- It exits 0 when the escrow is no longer open, and stops cleanly on Ctrl-C.
- It prints one line of JSON per delivery it judged, and one when it stops.

## Rules

- Reuse `judge`. Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- Tests run in the existing harness with `--sandbox viper` or a stubbed check; no real sleeps beyond the harness clock.
- Document it in `docs/judge.md` in at most three short sentences. Regenerate `docs/reference`. Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: a failing then a passing delivery (pays the passing one), a delivery judged only once, an escrow that closes while watching, and preview mode without `--yes`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
