# Job: ViperJS keeps lone surrogates in strings, as ECMAScript requires

The Solive judge runs deliveries in ViperJS (https://github.com/MerlijnW70/viperjs), pinned at commit 51941c4162591d3d9961645bcaa8ff26056926e7 and built by Solive's scripts/viper-judge.sh. ECMAScript strings are sequences of 16-bit code units and may hold unpaired surrogates. In ViperJS a lone surrogate becomes U+FFFD inside the engine: `String.fromCharCode(0xd800).charCodeAt(0)` is 65533, not 55296, and the string `"\ud800"` compares equal to `"�"`. Solive's judge works around this by failing drawn answers that may have been changed (commit b55760d), but a delivery that handles surrogates correctly still behaves differently in ViperJS than in any other engine.

## Required

1. Strings hold any sequence of UTF-16 code units, including unpaired surrogates, through every operation: literals and escapes, `String.fromCharCode`, `charCodeAt`, `codePointAt`, `length`, indexing, `slice` and the other String.prototype methods, concatenation (two halves joined form a pair), comparison, property keys, template literals, `JSON.parse` and `JSON.stringify` (well-formed `JSON.stringify` escapes a lone surrogate as `\udxxx`), and `String.prototype.isWellFormed` and `toWellFormed` if the engine has them or adds them.
2. Text leaving the engine through an interface that must be UTF-8 (the judge driver's output, printing) encodes a lone surrogate the way the interface documents; the viperjs-judge driver's output format documents what it does with one, so the Solive judge can tell an exact answer from a replaced one.
3. Tests in the ViperJS repository cover each operation in Required 1 with lone surrogates at the start, middle and end of strings, pairs formed by concatenation, and the U+FFFD comparison that is wrong today; the expected values are written into the tests (computed once with V8 and stated as such).
4. The repository's test262 run passes at least as many tests as at 51941c4, and no test262 test that passed there fails.
5. The `viperjs-judge` crate still builds with Solive's scripts/viper-judge.sh toolchain (Rust 1.99.0, wasm32-unknown-unknown, `--locked`), its output stays deterministic, and the heap and step budgets still hold for strings (a string's size counts against the heap budget as before).

## Rules

- Follow the ViperJS repository's own rules and style; no new dependency. Safe Rust only, as the repository is.
- Do not change anything in Solive; the judge re-pins the wasm after merging.

## Acceptance

1. The patch applies to ViperJS at 51941c4 and the repository's own test commands and CI checks pass.
2. The tests in Required 3 pass, and fail when the judge makes `String.fromCharCode` map a lone surrogate to U+FFFD again.
3. Solive's full TypeScript suite passes when the judge rebuilds the pinned wasm from the patched ViperJS.

## Deliver

One `git format-patch` file against ViperJS 51941c4. Announce its sha256 to the judge.
