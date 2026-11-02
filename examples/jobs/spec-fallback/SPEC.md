# Job: Read a job's spec by its hash when its url fails (J1)

A job's spec is reachable today only through the url in a memo of the escrow's creation transaction. A 4xx, any redirect, a slow host, an edit on a branch, or node history that no longer reaches that transaction makes the job unreadable, and `find_jobs` then hides it. The escrow already stores the spec's sha256 (`spec_hash`). Let every reader find the bytes from other sources by that hash and verify them, so no single host can make a job unreadable. Two research reports are in `F:\solive-kit\kill-wave\job-discovery-research\report.md` and `F:\solive-kit\kill-wave\spec-store-stack\report.md`.

## Build

1. **CID from the hash.** In `packages/client`, export `cidOfSpecHash(hex)`, returning the CIDv1 raw sha2-256 string (`"b"` plus base32-lower of the bytes `0x01 0x55 0x12 0x20` and the hash), and `specHashOfCid(cid)`, returning the hex for a CIDv1 raw sha2-256 CID and null for anything else. No new production dependency.
2. **Sources.** Export a `SpecSource` type with the kinds `memo`, `mirror` (`GET {base}/sha256/{hex}`), `ipfs` (`GET {gateway}/ipfs/{cid}?format=raw` with `Accept: application/vnd.ipld.raw`) and `arweave` (a POST GraphQL tag query for a `Spec-Sha256` tag, then `GET {gateway}/raw/{id}`), a `DEFAULT_SPEC_SOURCES` list (memo first; IPFS gateways that answer directly without a redirect; Arweave), and `ClientOptions.specSources` to replace it. The fetch used for specs gains POST for the GraphQL call; nothing else about it changes.
3. **Read with fallback.** `readSpec` tries the memo url as today, then each other source in order when the memo url is missing, fails or its bytes do not match. Every source goes through the same SSRF guard, the size cap, the timeout and the no-redirect rule as today. Bytes from a hash source count only when their sha256 equals `spec_hash`; mismatching ones are dropped and the next source is tried. Sealed specs keep today's path: a hash source never returns sealed bytes. The result says which source served the spec and lists what was tried and why it failed.
4. **Cache.** Verified spec bytes are kept in memory by hash (bounded in count and size), since the content of a hash never changes.
5. **Find jobs.** `find_jobs` (`packages/cli/src/job-pages.ts`) lists a job whose memo url is missing or unreadable when a hash source serves its spec. `solive_get_spec` reports the source.
6. **Docs.** Document the sources, how to set them, and that every byte is verified, in `docs/sdk-client.md` and `docs/mcp.md` in the repository's terse style. Update the API report.

## Tests

Each fails if its behaviour breaks: `cidOfSpecHash` of sha256("hello world") is `bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e` and of the three demo specs matches a fixture; `specHashOfCid` refuses other versions, codecs and hashes; a memo url answering 404 plus a source with the right bytes gives `matches: true` from that source; a source with wrong bytes is skipped for the next; a redirect, a private address and an oversize body from a hash source are refused; a missing memo plus a hash source lists the job in `find_jobs`; sealed specs never come from a hash source; no source answering gives today's errors unchanged; the cache serves a second read without a request.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines; new logic in new files.
- No program change. Additions only to public exports and tool outputs.
- Tests use a fake fetch, never the network.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, and no weakening of the SSRF guard.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
