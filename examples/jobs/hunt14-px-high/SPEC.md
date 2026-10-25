# Bounty: what the tools sign (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of audit round H14, aimed at the code that changed since rounds H12 and H13: the signing tools, delivery v4 across instructions, reputation, sealed delivery and the judge.

## Scope

packages/cli/src: every command and MCP tool that signs (agent/, agent/wallet/, the --yes paths, Ledger signing, confirm and send); packages/multisig/src: review, approve, execute and the close guard. In this area a finding may also show a tool breaking an invariant on its own, with no attacker at all, as round H12's committee release did by sending a setup transaction it never previewed; an attacker here may also be whoever writes the spec, the work, an on-chain account or text the agent reads.

## Invariants

- **PX-1**: Every transaction a CLI command or MCP tool signs and sends was shown in the preview the user approved: each instruction's program, the accounts that move value and the amounts. Nothing is signed that the preview did not list, including setup, wrap, unwrap, account-creation and compute-budget transactions.
- **PX-2**: An approval binds its preview: when the instructions, recipients, amounts or fees at send time differ from what was previewed, beyond the tolerance the tool documents, the tool refuses instead of sending.
- **PX-3**: The wallet limits (per trade, per hour, and the MCP wallet's limits) cannot be exceeded by any sequence of calls: splitting, retries, concurrent calls, wraps and unwraps, escrows, swaps or fills.
- **PX-4**: The multisig tool's review never describes an instruction of a vault proposal as harmless when it changes program code or the upgrade authority, closes program data or a buffer, or moves vault funds, and approve and execute refuse or warn exactly as that review says.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, or standing that misstates a worker's record. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; wallet-slot fingerprints being checked by the client rather than the program; a mint's freeze authority (T-83); delivered code noticing that it is being judged; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it); reputation scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file, either packages/cli/test/hunt/px-<short-name>.test.ts (the cli package; its test harness and the client test world may be used) or packages/multisig/test/hunt/px-<short-name>.test.ts (the multisig package and its test helpers). Each failing test's title starts with the invariant id, for example `PX-1 signs ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in that package (with --config ./vitest.setup.ts in packages/cli) three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/cli, packages/multisig, packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
