# Job: price rent from the cluster, not a constant

`packages/cli/src/agent/budget.ts` fixes rent at 6,960 lamports per byte. Devnet and mainnet charge 5,080 since SIMD-0437 (11 September 2026), and further cuts are planned. So the relayer and mandate budgets reserve too much, the relay preview states the wrong cost, and the crank funds a spare token account with too many lamports. If a later SIMD raises rent above the constant, that funding transaction fails.

## Build

1. **Live rate.** Read the rent sysvar through the client (as `rentExemptMinimum` does) and derive lamports per byte. Accept only rates from 696 to 6,960 inclusive. Outside that range, or when the sysvar is missing, refuse with a message naming the rate seen. Never fall back to a constant.
2. **One read per process.** Read the rate once per process and reuse it.
3. **Every caller uses it.** `rentFor`, `createCost` and their callers (relay and mandate budgets, the relay cost preview, crank `FUNDING_RENT`) take the live rate. Remove `RENT_LAMPORTS_PER_BYTE`.
4. **Crank funding matches the cluster.** The spare token account the crank creates gets exactly the rent-exempt minimum for its size at the live rate.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Do not change the program. Change only `packages` and `docs`; update any doc that names the old rate.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show that at 5,080 a create reserves `(intent bytes + 128) × 5,080 + (170 + 128) × 5,080` of rent; that rates 695 and 6,961 and a missing sysvar are refused; that the sysvar is read once across several budget calls; and that crank funding equals the rent-exempt minimum at the test rate.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
