# Job: The multisig tool refuses what it cannot show (D12)

The deep audit of the multisig tool (A2 M1, M2, M3, M4, M7, M8, M13) found these faults in `packages/multisig`, the tool whose keys control the program's upgrade authority.

## Build

1. **Every loader instruction is decoded or refused.** `review.ts` decodes only Upgrade, SetAuthority and Close of the upgradeable loader; Write, DeployWithMaxDataLen, ExtendProgram, Migrate (which moves the program to a loader this tool cannot upgrade), ExtendProgramChecked and unknown tags pass review with no problem, against the operations doc and the threat model, which say review refuses what it cannot show. Decode them or raise a problem for each, so approve and execute refuse them.
2. **Key files are checked like the CLI's.** `keys.ts` loads member keys without the CLI's refusal of group- or world-readable key files and without `~` expansion. Use one shared key-file loader for both packages.
3. **Propose shows review problems.** `propose` drops review problems, so it creates and pays for a proposal that approve will refuse. Show them at propose and refuse unless an explicit override is given.
4. **Unused flags are refused.** Only some commands refuse flags they do not use, so `create --seconds 3600` silently gives time lock 0 and `execute --expect-buffer-hash` on a config proposal is ignored. Refuse flags a command does not use.
5. **Draft and stale proposals get true refusals.** Approve, reject and config execute do not check the stale transaction index and give misleading refusals for drafts. Check it and say what is wrong.
6. **propose-admin checks before running the inner command.** It runs the inner command before any check, so a forgotten `--authority` with `--yes` sends. Check first.
7. **Trust boundary stated.** Review trusts one RPC node and `--url` accepts plain http. Refuse plain http for a non-local node, and state the trust boundary in `docs/maintainers/operations.md`.

## Tests

Each item has a test that fails without its fix: approve refuses a vault-signed loader Migrate and an unknown tag; a group-readable key file is refused on Unix; propose shows a review problem; `create --seconds 3600` is refused; a stale proposal gets the stale refusal; propose-admin without `--authority` sends nothing; plain http to a remote node is refused.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/multisig`, a shared key-file loader with its CLI call site in `packages/cli/src/main.ts` if moved, `docs/maintainers/operations.md` and tests. No program change, no real multisig transaction.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
