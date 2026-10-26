# Job: The client accepts a transaction signature from the RPC node only in its real form

The client reads transaction signatures from the RPC node in several places: listed signatures, transactions read back, signature statuses and send results (packages/client/src/rpc-transport.ts and rpc-shapes.ts). It passes them on as strings, typed with a cast, without checking their form. The CLI and the MCP servers then show them, and use them in receipts, history, links and next hints. A faulty or misconfigured node can hand over any text in those fields. The untrusted-text inventory in the CLI (`packages/cli/src/agent/untrusted-fields.ts`) currently files these fields as chain values under threat T-46 instead of checking them.

## Required

1. One function in the client decides whether a string is a transaction signature: base58 that decodes to exactly 64 bytes. Use the `@solana/kit` helpers if they do exactly this. The rpc transport applies it where every signature enters from the node.
2. A value that is not a signature never reaches a caller as a `Signature`. For each place, choose one behaviour and document it:
   - the entry is treated as unreadable, and is reported the way the client already reports unreadable data (`complete: false`, unreadable lists);
   - or the call fails with a named error.
   A bad entry must not be silently dropped in a way that makes a scan look complete.
3. The CLI's untrusted-text inventory then files these fields as checked values. Its tests prove that a node returning a non-signature in each place cannot put that text into any tool output.
4. Test fakes that use made-up signature strings use well-formed ones from one shared helper. Update the about 31 test files that need it without weakening what they test.
5. A short note in docs/maintainers/threat-model.md (T-46) says what is now checked.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change the program, the IDL or the generated client.
- Keep TypeScript files under about 500 lines.
- Another worker this wave changes CLI onboarding (setup, add-to, create previews, cancel, jobs, docs). Keep your CLI change to the untrusted-text inventory and its tests, and rebase onto the latest `main` before delivering.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. For each entry place in Required 1, a test feeds a non-signature from a fake node and shows the documented behaviour.
3. A test fails when the judge removes the check from the listed-signatures path.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
