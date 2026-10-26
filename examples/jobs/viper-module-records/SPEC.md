# Job: ViperJS keeps one module record per module, even after a chunk is freed

The Solive judge runs deliveries in ViperJS (https://github.com/MerlijnW70/viperjs), pinned by Solive's scripts/viper-judge.sh. This job's base is ViperJS commit 8a89811b1b5f1d72df1495b76d272f3c37ef8f69, master after the template-site fix (pull request 19).

The machine's module map (the `modules` map in src/vm/mod.rs) keys each record by a chunk's address. Both `run_module` and the graph linker (`identity` in src/vm/module.rs) do this, and no record is ever removed. A chunk's address is stable only while the chunk lives. So when a host runs one module chunk after another from the same place, the second chunk finds the first one's record:
- `import.meta` returns `Fault::ImportMetaOutsideModule` instead of an object;
- the record already says `evaluated: true`, so a later graph whose chunk lands on that address may skip its body.

The map also grows with every module run, for as long as the machine lives. This is the same class of bug as the template-object cache fixed in pull request 19.

## Required

1. Each module (a lone `run_module` chunk, or a module in a linked graph) gets its own record, keyed by an identity that cannot be reused while its record exists. Running a module chunk again is the same module, per §16.2.1.6. A different chunk is never mistaken for a module already evaluated, even when an earlier chunk was freed before it was compiled.
2. A module's record (environment, namespace, `import.meta` object) does not stay reachable once no code can reach the module. Either collect it with its code, or bound and document what the machine keeps. Record the choice in a decision record, the way DR-0032 does for template objects.
3. Audit every other map in the engine keyed by an address or another reusable handle. Fix each one at its cause, or show in a test why its key cannot be reused while its entry lives.
4. Tests in the ViperJS repository:
   - two module chunks run one after another from the same local, each with its own `import.meta` and each body run once;
   - many module runs in a loop (enough to make address reuse likely), each evaluated exactly once with its own record;
   - a graph that imports a module run earlier sees it as evaluated only when it is the same module;
   - the memory a long series of module runs keeps stays bounded under the heap budget.
   Write the expected values into the tests. Compute them once with V8 or Node and say so.
5. The repository's test262 run passes at least as many tests as at the base, and no test262 test that passed there fails.
6. The `viperjs-judge` crate still builds with Solive's scripts/viper-judge.sh toolchain (Rust 1.99.0, wasm32-unknown-unknown, `--locked`). Its output stays deterministic, and the heap and step budgets still hold.

## Rules

- Follow the ViperJS repository's own rules and style. No new dependency. Safe Rust only.
- Do not change anything in Solive; the judge re-pins the wasm after merging.

## Acceptance

1. The patch applies to the base commit, and the repository's own test commands and CI checks pass.
2. The tests in Required 4 pass.
3. A test fails when the judge keys `run_module`'s record by chunk address again.
4. Solive's full TypeScript suite passes when the judge rebuilds the pinned wasm from the patched ViperJS.

## Deliver

One `git format-patch` file against the base commit. Announce its sha256 to the judge.
