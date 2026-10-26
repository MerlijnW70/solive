# Job: ViperJS gives each tagged-template site its own template object, even after a chunk is freed

The Solive judge runs deliveries in ViperJS (https://github.com/MerlijnW70/viperjs). It is pinned at commit 3eac2329d6013c409aaa413af36bbcfa32ed2764 and built by Solive's scripts/viper-judge.sh.

ECMAScript §13.2.8.3 (GetTemplateObject) caches one template object per realm and Parse Node. In ViperJS, the template-object instruction in src/vm/execute.rs keys that cache (the VM's `templates` map) by the running chunk's address plus the site index. A chunk's address is stable only while the chunk lives. Code compiled by `eval` or `new Function`, or a function whose chunk is dropped, can free a chunk. A later chunk allocated at the same address then gets the earlier site's template object, with the earlier strings. The cache is also a GC root (src/vm/mod.rs), so its entries never go away, and a program that keeps compiling new sites grows it without bound.

## Required

1. Each tagged-template site gets its own template object, per the spec, for every way code is compiled:
   - scripts;
   - modules;
   - functions;
   - direct and indirect `eval`;
   - `new Function`.
   The same site evaluated again returns the same object. Two different sites never share one, even when one chunk was freed before the other was compiled. Key the cache by an identity that cannot be reused while its entry exists, not by an address.
2. Template objects for sites whose code can never run again do not stay reachable for ever. Either they are collected with their code, or their count is bounded and charged to the heap budget. Choose one and document it.
3. Tests in the ViperJS repository cover each point:
   - the same site in a loop and across calls gives the same object;
   - two sites with equal text give different objects;
   - many `eval` and `new Function` sites created and dropped in a loop (enough to make address reuse likely under the test allocator) each get their own object with their own strings;
   - the cache's size stays bounded, or is collected, over such a loop under the heap budget.
   Write the expected values into the tests. Compute them once with V8 and say so.
4. The repository's test262 run passes at least as many tests as at 3eac232, and no test262 test that passed there fails.
5. The `viperjs-judge` crate still builds with Solive's scripts/viper-judge.sh toolchain (Rust 1.99.0, wasm32-unknown-unknown, `--locked`). Its output stays deterministic, and the heap and step budgets still hold.

## Rules

- Follow the ViperJS repository's own rules and style. No new dependency. Safe Rust only, as the repository is.
- Do not change anything in Solive; the judge re-pins the wasm after merging.

## Acceptance

1. The patch applies to ViperJS at 3eac232, and the repository's own test commands and CI checks pass.
2. The tests in Required 3 pass.
3. A test fails when the judge keys the cache by chunk address again.
4. Solive's full TypeScript suite passes when the judge rebuilds the pinned wasm from the patched ViperJS.

## Deliver

One `git format-patch` file against ViperJS 3eac232. Announce its sha256 to the judge.
