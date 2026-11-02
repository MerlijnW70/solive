# Job: Publish a job's spec to the mirror when its escrow is sent (J4)

The mirror in `services/specs` is live at `https://solive-specs.vercel.app`, and readers can use it as a source (`packages/client/src/spec-sources.ts`), but no reader asks it by default and nothing uploads to it, so a job whose url fails stays unreadable. A research report is in `F:\solive-kit\kill-wave\spec-store-stack\report.md`.

## Build

1. **Readers ask the mirror.** `DEFAULT_SPEC_SOURCES` lists the mirror right after `memo`, before the IPFS and Arweave sources. Export its url as `DEFAULT_SPEC_MIRROR`.
2. **Upload.** Export `publishSpec(bytes, options)` from `packages/client`. It hashes the bytes itself, sends `PUT {mirror}/sha256/{hex}` through the same guarded fetch readers use, and returns `{ published: true, sha256, url }` or `{ published: false, sha256, reason }`. A 403 straight after sending is expected while the node catches up, so it retries with a short bounded backoff, within a total budget equal to `SPEC_READ_MS`. It never throws on a refused or failed upload.
3. **At escrow time.** After `solive_wallet_escrow` and the CLI `create attested` confirm a send:
   - With `spec_url`: fetch it through the existing guard, and upload only when its bytes hash to `spec_hash` and are not sealed. The url is already public in the memo, so this discloses nothing new and is the default.
   - With a new optional `spec_text` on the MCP tool (and `--spec-file` on the CLI): refuse before sending when its hash differs from `spec_hash`, and upload it after the send.
   - `publish_spec: false` (CLI `--no-publish-spec`) turns the upload off.
   - The preview states that the spec goes to the mirror, and the result holds `spec_published`. A failed upload never fails the escrow; the result says why, with a next hint.
   - Sealed specs are never uploaded. The plan tool `solive_wallet_escrow_plan` gets the same behaviour for each piece, or says plainly in its result that it does not publish.
4. **Where.** `INTENT_ENGINE_SPEC_MIRROR` replaces the mirror url for both the upload and the default source; empty turns the mirror off. It passes the same url guard as other urls.
5. **Docs.** Document all this in `docs/sdk-client.md` and `docs/mcp.md`, update the wallet notice only if a host is missing from it, within the limits in `plain-words.test.ts`, and update the API report and generated tool reference. In the README of `services/specs`, say that connecting a Blob store today sets `BLOB_STORE_ID` and uses OIDC, in place of the token it names, and that `DEFAULT_SPEC_SOURCES` lists the service.

## Tests

Each fails if its behaviour breaks: the default list has the mirror second; `publishSpec` sends the exact bytes to the right path, retries a 403 within its budget and stops, reports a refusal without throwing, and goes through the SSRF guard; an escrow with a matching `spec_url` uploads once after the send and not before; a url whose bytes do not match or are sealed uploads nothing; `spec_text` with a wrong hash refuses before anything is sent, and with the right hash uploads; `publish_spec: false` uploads nothing; a failed upload leaves the escrow result successful with the reason; a preview sends nothing to the mirror; the environment variable replaces and turns off the mirror; a spec read through the real handler of the mirror service, end to end after `publishSpec`, gives `source: "mirror"`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines, new logic in new files.
- No program change. Additions only to public exports and tool outputs. Tests never use the network.
- Do not touch `services/faucet`; another job is changing it. In `services/specs`, touch only its README.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, and no weakening of the SSRF guard.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
