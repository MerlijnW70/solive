# Job: The multisig review decodes the IDL update that scripts/idl.sh proposes

`bash scripts/idl.sh <cluster> --multisig` proposes an IDL update through the Squads vault. It exports the instructions of `@solana-program/program-metadata@0.10.0` `update idl --buffer ... --close-buffer ...`. The vault signs as the IDL's metadata authority. The review in packages/multisig/src/review.ts does not decode the program-metadata program. It calls the proposal a relayed vault signature (`relayedText`), so `approve` and `execute` refuse it unless a member passes `--allow-undecoded-vault-signer`. That override also lets through any other program, so a member who uses it to land a correct IDL update has stopped checking.

## Required

1. The review decodes every instruction of the program-metadata program at its 0.10.0 layout. Build the decoder from the program's published layout or client, and pin the version you used. For each instruction it shows:
   - the name;
   - every account and its role: metadata account, buffer, authority, program, program data, and any other account the instruction takes;
   - the data fields: seed, encoding, compression, format, data source, and the data or its length.
   An instruction it cannot decode, or that is malformed, is a problem that blocks approval exactly as today.
2. For the instructions the IDL update uses, the review checks and shows four things:
   - the metadata account is the canonical IDL account of the intent engine program for the vault as authority, and the review says when it is not;
   - the program is the intent engine program;
   - the buffer's authority, and the sha256 of the IDL bytes the buffer will set, decoded through its encoding and compression;
   - where the buffer's and the metadata account's lamports go when they are closed.
3. `execute --expect-buffer-hash` also covers a program-metadata buffer: the hash it compares is the decoded IDL bytes' sha256. `scripts/idl.sh --multisig` prints the sha256 of the local IDL file in the same form, so a member can compare the two. Keep it working for loader buffers as before.
4. A proposal made only of decoded program-metadata instructions for the engine's IDL no longer counts as a relayed vault signature. It approves and executes without `--allow-undecoded-vault-signer`. These still need the flag, or are refused as they are today:
   - a program-metadata instruction on another program's metadata;
   - one that hands the metadata authority to a key other than the vault;
   - one that closes the metadata account with its lamports going outside the vault;
   - any instruction of an undecoded program.
   Name each case's behaviour in a test.
5. Tests in packages/multisig, using its LiteSVM world with the real program-metadata program (load the program binary the way the tests load the others, pinned by hash). They cover:
   - the exact instruction list `idl.sh --multisig` proposes, reviewed, approved and executed, with the on-chain IDL afterwards equal to the local file;
   - every case in Required 4;
   - a buffer whose content differs from the expected hash, refused by `execute --expect-buffer-hash`.
6. docs/maintainers (the upgrade or multisig runbook) says how an IDL update is reviewed and that it needs no override.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change the program, the IDL or the generated client.
- Keep TypeScript files under about 500 lines.
- No new runtime dependency unless the decoder cannot be written from the published layout. Name the reason in the report if you add one.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The tests in Required 5 pass.
3. A test fails when the judge makes the review accept a program-metadata instruction whose metadata account belongs to another program.
4. A test fails when the judge makes the buffer hash skip decompression.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
