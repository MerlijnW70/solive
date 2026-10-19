# Job: a second node for the solver and a saved one for judges (T-45, T-46)

A judge reads one RPC node unless it passes `--confirm-url` every time, so a node that hides history can make it pay the wrong worker (threat-model row T-45). The solver takes its quotes and balances from one node only (T-46).

## Build

- `intent-engine solve` (including `--watch`) takes `--confirm-url <cluster or url>`. Before it sends a fill, it rereads from that node the accounts and balances the fill relies on, and skips the fill, with a reason in its report, when the two nodes disagree.
- The saved config (`intent-engine setup` and the config file `judge` already reads defaults from) can hold a `confirm-url`. `judge`, `judge --watch`, `committee release` and the release MCP tools use it when no `--confirm-url` is given, so a judge sets it once.
- A judge or release with no second node configured prints, once, that it reads one node, naming the setting.

## Rules

- Reuse the existing confirm code (`confirmOnBoth` and its tests); do not add a second implementation.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/solver.md` and `docs/judge.md` in at most three sentences each, the T-45 and T-46 rows in `docs/maintainers/threat-model.md`, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: the solver skips a fill when the second node disagrees about a balance or the intent and sends it when they agree; a judge with `confirm-url` in its config refuses on disagreement without the flag; the flag overrides the config; and the one-node notice appears only when no second node is set.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
