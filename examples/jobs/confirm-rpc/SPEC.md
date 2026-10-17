# Job: check a second node before paying

A judge reads everything it pays on from one RPC node: the escrow, and the record of who announced a delivery first. A lying or lagging node can hide an earlier announcer or show a false escrow, and the judge pays the wrong wallet.

## Build

- `intent-engine judge`, `intent-engine committee release` and the MCP server (for `wallet_attest` and the other release tools) take `--confirm-url <rpc>`, in the forms `--url` accepts.
- With it, before signing a release, the escrow intent account and the earliest announcer of the delivered sha256, with its announcement signature, are read from both nodes. The release goes ahead only when both nodes report the same genesis hash, the same intent account bytes and the same earliest announcer. Otherwise it is refused with `ConfirmMismatch`, naming what differed and both values, and nothing is signed or sent.
- A second node that cannot be read refuses the release the same way; it never falls back to one node.
- Without `--confirm-url`, everything is as today.

## Rules

- Keep every check judging has today. The second node only adds refusals.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag in `docs/judge.md` in at most three short sentences. Regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests use two stub transports and no network. They cover: two agreeing nodes release; a second node with another genesis, other intent bytes, another earliest announcer, or an announcement the first node hid each refuse with `ConfirmMismatch` and send nothing; an unreadable second node refuses; the same for `committee release` and the MCP `wallet_attest`; no flag behaves as today.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
