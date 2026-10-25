# Job: ViperJS lowers and uppercases strings the way ECMAScript requires

The Solive judge runs deliveries in ViperJS (https://github.com/MerlijnW70/viperjs), pinned at commit d2bccdb8f77f78bddf07fad22ec76bfedbfbbf0f and built by Solive's scripts/viper-judge.sh. Audit round H14 (packages/cli/test/hunt/js-final-sigma.test.ts in Solive) showed that `'ΟΔΟΣ'.toLowerCase()` gives `"οδοσ"` in ViperJS, while ECMAScript's String.prototype.toLowerCase requires the Final_Sigma context of Unicode's SpecialCasing and gives `"οδος"`, as V8 does. The judge combines its engines with AND, so a correct delivery that lowers such a string is refused.

## Required

1. `String.prototype.toLowerCase`, `toUpperCase`, `toLocaleLowerCase` and `toLocaleUpperCase` (the last two without a locale argument behaving as the first two, as an engine without Intl may) follow ECMAScript: the full Unicode case mappings, including the unconditional SpecialCasing mappings that change a string's length (for example `'ß'.toUpperCase()` is `"SS"`, `'İ'.toLowerCase()` is `"i̇"`) and the Final_Sigma condition for U+03A3. The Unicode version used is stated in the code's data or build, and matches what ECMAScript's current edition requires or the newest version the repository already uses.
2. Tests in the ViperJS repository cover Final_Sigma (word-final, word-medial, alone, before and after case-ignorable characters such as U+0345 and apostrophes, and at the ends of the string), the length-changing mappings in both directions, and a corpus compared with the expected output written into the test (computed once with V8 and stated as such).
3. The repository's test262 run passes at least as many tests as at d2bccdb, and no test262 test that passed there fails.
4. The `viperjs-judge` crate still builds with Solive's scripts/viper-judge.sh toolchain (Rust 1.99.0, wasm32-unknown-unknown, `--locked`) and its output stays deterministic: two builds give the same sha256.

## Rules

- Follow the ViperJS repository's own rules and style; no new dependency unless the repository already uses it for Unicode data. Safe Rust only, as the repository is.
- Do not change anything in Solive; the judge re-pins the wasm after merging.

## Acceptance

1. The patch applies to ViperJS at d2bccdb and the repository's own test commands and CI checks pass.
2. The tests in Required 2 pass, and fail when the judge removes the Final_Sigma handling.
3. Solive's hunt test js-final-sigma passes when the judge rebuilds the pinned wasm from the patched ViperJS.

## Deliver

One `git format-patch` file against ViperJS d2bccdb. Announce its sha256 to the judge.
