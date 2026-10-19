# Job: propose a multisig time lock change

`intent-engine-multisig` can decode, approve and execute a Squads config transaction that changes the time lock (`review.ts` shows "Changes the time lock from … to … seconds"), but it cannot propose one, so changing the upgrade time lock needs the Squads app.

## Build

- `intent-engine-multisig propose-time-lock --multisig <m> --seconds <n> --keypair <member> [--yes]` proposes a Squads v4 config transaction with one `SetTimeLock` action, previewing and simulating first and sending only with `--yes`, like the other propose commands. `n` is a whole number from 0 to `MAX_TIME_LOCK`.
- `show --index <i>` decodes it as today, and `approve`/`execute` sign it with `--allow-config` as today.
- `docs/maintainers/operations.md` documents the command next to `--time-lock` on `create`, in at most three sentences, including that the new time lock also delays this change's own successors.

## Rules

- Reuse the existing Squads instruction builders, codecs and the propose flow; tests use the existing LiteSVM Squads harness of `packages/multisig`.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Change only `packages/multisig` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a proposal that, after two approvals and execution, sets the multisig's time lock to the requested value; a later vault upgrade proposal then cannot execute before the time lock passes; a value above `MAX_TIME_LOCK` or a non-member signer is refused before sending.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
