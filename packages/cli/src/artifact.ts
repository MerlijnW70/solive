import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ManifestEntry, manifestSha256 } from "@intent-engine/core";
import { JudgeRefused } from "./judge-errors.js";

export const SKIPPED = new Set([".git", "node_modules", "target"]);

export const SPEC_COPY = "SPEC.md";
export const CLEANUP_RETRIES = 5;

const EXECUTABLE = 0o111;

type CopiedEntry = ManifestEntry & { executable: number };

async function readEntry(path: string, full: string): Promise<CopiedEntry> {
  const handle = await open(full, "r");
  try {
    const { mode } = await handle.stat();
    return { path, bytes: await handle.readFile(), executable: mode & EXECUTABLE };
  } finally {
    await handle.close();
  }
}

async function filesUnder(root: string, prefix: string): Promise<CopiedEntry[]> {
  const entries: CopiedEntry[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await filesUnder(full, path)));
    } else if (entry.isFile()) {
      entries.push(await readEntry(path, full));
    } else {
      throw new JudgeRefused(`the artifact holds ${path}, which is neither a regular file nor a directory; the judge hashes only those`);
    }
  }
  return entries;
}

export type Artifact = { sha256: string; entries: CopiedEntry[]; single: boolean };

export async function readArtifact(path: string): Promise<Artifact> {
  const found = await stat(path);
  if (found.isFile()) {
    const entry = await readEntry(basename(path), path);
    return { sha256: createHash("sha256").update(entry.bytes).digest("hex"), entries: [entry], single: true };
  }
  if (found.isDirectory()) {
    const entries = await filesUnder(path, "");
    return { sha256: await manifestSha256(entries), entries, single: false };
  }
  throw new JudgeRefused(`--artifact ${path} is neither a regular file nor a directory`);
}

export async function artifactSha256(path: string): Promise<string> {
  return (await readArtifact(path)).sha256;
}

type Copy = { root: string; path: string; spec: string };

export async function removeCopy(root: string): Promise<string | undefined> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    return undefined;
  } catch (error) {
    return `the artifact copy at ${root} could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function copyOf(artifact: Artifact, specBytes: Uint8Array): Promise<Copy> {
  const root = await mkdtemp(join(tmpdir(), "judge-artifact-"));
  const work = join(root, "work");
  const spec = join(root, "spec", SPEC_COPY);
  try {
    await mkdir(work);
    await mkdir(dirname(spec));
    await writeFile(spec, specBytes);
    for (const entry of artifact.entries) {
      const target = join(work, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.bytes);
      if (entry.executable !== 0) {
        await chmod(target, ((await stat(target)).mode & 0o777) | entry.executable);
      }
    }
  } catch (error) {
    await removeCopy(root);
    throw error;
  }
  const [only] = artifact.entries;
  return { root, spec, path: artifact.single && only !== undefined ? join(work, only.path) : work };
}
