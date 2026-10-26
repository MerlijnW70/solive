# Job: The multisig review hashes what a proposal will set, not what a buffer holds before it runs

Round H16 found a gap in the multisig review (packages/multisig). The review and `execute --expect-buffer-hash` hash a buffer as it stands on chain before the vault transaction runs: `describeInstructions` in review.ts, `bufferSource` in program-metadata.ts, and `requireBuffers` and `recheck` in squads.ts. An earlier instruction in the same proposal can change that buffer. For example, a program-metadata Write signed by the vault can overwrite the buffer before the SetData that reads it. The members then approve, and the executor's hash check passes, while the IDL that lands on chain is one nobody approved. The same applies to Extend and Trim, and to any instruction that writes an account a later instruction reads.

`examples/jobs/multisig-post-state/case.patch` adds the test that shows this, a file named ms-write-before-set.test.ts under the multisig test directory. It fails on `main` today.

## Required

1. The review knows, for each instruction, which accounts earlier instructions in the same message write. A buffer, metadata account or program data account that an earlier instruction writes and a later one reads is never reported with a pre-transaction hash as if it were what the later instruction uses. For each such account the review either:
   - computes exactly what the earlier instructions do to it, for the instructions it decodes, and hashes the result; or
   - reports a problem that blocks approval unless the member passes an explicit flag.
   Choose one per case and document it.
2. `execute --expect-buffer-hash` compares against what the executed transaction will set. Before sending, execute simulates the exact vault-execute transaction it will send. It reads the resulting state of every IDL account and program data account the proposal sets, and refuses unless the bytes set hash to the expected value: decoded through the account's encoding and compression for an IDL, and the program's executable hash for a program. Approve does the same check in its preview, so a member sees the hash the transaction really produces.
3. The case test passes after the fix. Turn it into a regular test outside `test/hunt/`, asserting that the proposal is refused or shows the forged hash. The existing honest flows still work without new flags:
   - the `scripts/idl.sh --multisig` update;
   - the `scripts/deploy.sh --multisig` upgrade.
4. Tests in packages/multisig, using its LiteSVM world with the real programs:
   - Write, Extend and Trim before SetData;
   - a write to an unrelated account before SetData (the honest result);
   - an execute whose simulation sets bytes different from the expected hash;
   - the loader upgrade path's simulated program hash.
5. docs/maintainers/threat-model.md gets a row, and the multisig runbook says what members now see.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change the program, the IDL or the generated client.
- Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The tests in Required 4 pass, and the case from the patch is refused.
3. A test fails when the judge makes execute skip its simulated post-state check.
4. A test fails when the judge makes the review ignore writes by earlier instructions.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
