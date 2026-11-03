# Job: A limit on what the spec mirror stores in total (J3b)

The mirror in `services/specs` keeps every accepted spec for good, and every escrow sent with a spec now uploads to it by default. Its only limits are the size of one spec, an open escrow, and a rate limit per function instance. Someone with many addresses can open escrows, upload, cancel and repeat, and fill the Blob store on the owner's account. The README of the service already says this is open.

## Build

1. **Total cap.** Add `MAX_STORED_BYTES` to `services/specs/src/limits.ts`, set to 536870912. Before a new write, after every existing check, `services/specs/src/mirror.ts` asks the store how many bytes it holds. At or over the cap, or when this write would pass it, the answer is 507 with a new reason in `REASONS`, and nothing is written. A repeat upload of a stored spec still answers 200 and costs no count. Reads are not affected: everything stored stays readable.
2. **Store.** `SpecStore` gains a way to give the total, built on the Blob client's list call over the `sha256/` prefix, summing sizes across pages, with the same time bound as other store calls. A count that cannot finish refuses with 503 and writes nothing, so failure closes the upload and never opens it. No new production dependency.
3. **Client.** `publishSpec` treats 507 as final, with no retry, and reports the reason. Check how it treats a status it does not know today. Add this only if it is needed, and say which.
4. **Docs.** Update the table and the section "Before wide public use" in the README of the service: what the cap is, that it is soft since instances can pass it together by a few writes, and what still has no limit (reads).

## Tests

Each fails if its behaviour breaks: under the cap a write goes through; at the cap, and when this write would pass it, the answer is 507 and nothing is stored; a repeat of a stored spec answers 200 at the cap with no count asked; reads work at the cap; a count that fails or times out answers 503 and stores nothing; a refused upload never asks for the count; the count sums across pages with the real Blob client against a local server; the literal value of the cap is pinned; `publishSpec` makes one request on a 507 and returns the reason.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Tests never use the network. Upload nothing to the live mirror, and deploy nothing.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
