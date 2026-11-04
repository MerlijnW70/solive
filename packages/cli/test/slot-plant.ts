import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OUTSIDE_MODE = 0o751;

const tolerated = (done: Promise<unknown>) => done.catch(() => undefined);

export async function planted(slot: string, outside: string): Promise<string> {
  await mkdir(outside, { recursive: true });
  await chmod(outside, OUTSIDE_MODE);
  await tolerated(writeFile(join(outside, "kept"), "outside"));
  await chmod(join(outside, "kept"), 0o444);
  for (const dir of [slot, join(slot, "work"), join(slot, "spec"), join(slot, "judge")]) {
    await mkdir(join(dir, "ro-dir"), { recursive: true });
    await tolerated(writeFile(join(dir, ".hidden"), "left"));
    await tolerated(writeFile(join(dir, "ro.txt"), "left"));
    await chmod(join(dir, "ro.txt"), 0o444);
    await tolerated(writeFile(join(dir, "ro-dir", "inner"), "left"));
    await chmod(join(dir, "ro-dir"), 0o555);
    await tolerated(symlink(outside, join(dir, "link")));
    await tolerated(symlink(join(outside, "kept"), join(dir, "file-link")));
  }
  for (const dir of [join(slot, "work"), join(slot, "spec"), join(slot, "judge")]) {
    await chmod(dir, 0o555);
  }
  return outside;
}
