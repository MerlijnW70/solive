import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimRoot, removeRoot, SCRATCH_DIR, sweepStale } from "./run-root.js";

export default function setup(): () => void {
  const base = tmpdir();
  sweepStale(base);
  const root = claimRoot(base);
  const scratch = join(root, SCRATCH_DIR);
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    process.env[name] = scratch;
  }
  const finish = (): void => {
    removeRoot(base, root);
  };
  process.once("exit", finish);
  return finish;
}
