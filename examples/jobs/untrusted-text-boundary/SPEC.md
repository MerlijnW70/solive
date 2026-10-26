# Job: Keep text from other parties out of the MCP servers' instructions and structured fields

The MCP servers in packages/cli/src/agent return text that other parties control:
- spec text and work text, fetched from urls a payer or worker chose;
- on-chain strings such as profile skills, endpoints and doc urls, spec and work urls, and feedback;
- token names, RPC error messages and simulation logs.

An agent reads every tool result. Some of this text is already marked as data (`get_spec` `text`, `fetch_work` `untrusted_text`) or reduced to printable ASCII (`untrusted` in problems.ts), but nobody has listed every place it reaches a result.

## Required

1. Make a typed inventory, kept in the code and checked by a test:
   - every output field of every tool on both servers (the read server and the wallet server) that can carry text another party controls;
   - for each field, who controls the text;
   - which of these three rules the field follows:
     1. the field is named or described as untrusted data;
     2. the text is reduced by one shared sanitizer;
     3. the field is never rendered, only hashed.

   The test walks every tool's output schema. It fails on any string field the inventory neither lists nor marks as text this code writes itself.
2. Text from another party never reaches these parts of a result:
   - `next`, `hint`, the tool descriptions, or the server instructions;
   - any field an agent acts on without reading the text: `matches`, `verdict`, amounts, addresses, signatures, `send` previews, approval bindings, refusal codes.
   Where it reaches one of these today, move or reduce it at its cause.
3. One shared rule governs control characters, bidirectional and zero-width code points, and length: in every untrusted field, or reduced away in sanitized text. That covers newlines that could fake a new field or line, ANSI escapes, and U+202E. Text the sanitizer shortens says that it was cut.
4. The CLI's human output (the `--plain`/table output of the commands that print the same fields) applies the same rule. That way a terminal never runs an escape sequence taken from a spec, a work file, a profile or a log.
5. Tests for each tool in the inventory. Each test feeds hostile text through the test world (a spec, a work file, a profile, a feedback note, a token or error message, simulation logs) and shows three things: the structured fields are unchanged, the text appears only in its untrusted field or sanitized, and the previews and approvals still bind the same terms.
6. A short section in docs/maintainers (threat model or MCP notes) lists the inventory's rules. Update tool descriptions only where a field's meaning changes, and keep them short. Regenerate generated references.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change the program, the IDL or the generated client.
- Keep TypeScript files under about 500 lines.
- Keep public exports and tool names unless a field must move. Where one moves, update its callers, docs and tests.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The inventory test fails when the judge adds a new tool output field carrying spec text without listing it.
3. A test fails when the judge makes the shared sanitizer keep a newline or U+202E.
4. A test fails when the judge puts a profile's endpoint into a `next` hint.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
