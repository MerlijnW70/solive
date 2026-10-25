import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ManifestEntry, manifestSha256 } from "@intent-engine/core/internal";
import { UsageError } from "./arg-values.js";
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

export const MAX_ARTIFACT_BYTES = 67108864;
export const MAX_ARTIFACT_FILES = 10_000;

export const artifactTooLarge = (path: string, over: string): string =>
  `${path} ${over}, over the artifact limit of ${MAX_ARTIFACT_BYTES} bytes and ${MAX_ARTIFACT_FILES} files; nothing was run or paid`;

export class ArtifactTooLarge extends UsageError {
  constructor(path: string, over: string) {
    super(artifactTooLarge(path, over));
    this.name = "ArtifactTooLarge";
  }
}

type Found = { path: string; full: string };

type Walk = { root: string; files: Found[]; bytes: number };

async function walk(at: string, prefix: string, into: Walk): Promise<void> {
  for (const entry of await readdir(at, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = join(at, entry.name);
    if (entry.isDirectory()) {
      await walk(full, path, into);
    } else if (entry.isFile()) {
      into.files.push({ path, full });
      if (into.files.length > MAX_ARTIFACT_FILES) {
        throw new ArtifactTooLarge(into.root, `holds more than ${MAX_ARTIFACT_FILES} files`);
      }
      into.bytes += (await stat(full)).size;
      if (into.bytes > MAX_ARTIFACT_BYTES) {
        throw new ArtifactTooLarge(into.root, `holds more than ${MAX_ARTIFACT_BYTES} bytes`);
      }
    } else {
      throw new JudgeRefused(`the artifact holds ${path}, which is neither a regular file nor a directory; the judge hashes only those`);
    }
  }
}

async function filesUnder(root: string): Promise<CopiedEntry[]> {
  const found: Walk = { root, files: [], bytes: 0 };
  await walk(root, "", found);
  const entries: CopiedEntry[] = [];
  for (const { path, full } of found.files) {
    entries.push(await readEntry(path, full));
  }
  return entries;
}

export type Artifact = { sha256: string; entries: CopiedEntry[]; single: boolean };

export async function readArtifact(path: string): Promise<Artifact> {
  const found = await stat(path);
  if (found.isFile()) {
    if (found.size > MAX_ARTIFACT_BYTES) {
      throw new ArtifactTooLarge(path, `is larger than ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const entry = await readEntry(basename(path), path);
    return { sha256: createHash("sha256").update(entry.bytes).digest("hex"), entries: [entry], single: true };
  }
  if (found.isDirectory()) {
    const entries = await filesUnder(path);
    return { sha256: await manifestSha256(entries), entries, single: false };
  }
  throw new JudgeRefused(`--artifact ${path} is neither a regular file nor a directory`);
}

export async function artifactSha256(path: string): Promise<string> {
  return (await readArtifact(path)).sha256;
}

type Copy = { root: string; path: string; spec: string; check: string | undefined };

export type CheckFiles = { name: string; read: Artifact };

export const CHECK_COPY = "check";

export async function removeCopy(root: string): Promise<string | undefined> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    return undefined;
  } catch (error) {
    return `the artifact copy at ${root} could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function writeEntries(under: string, entries: readonly CopiedEntry[]): Promise<void> {
  for (const entry of entries) {
    const target = join(under, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes);
    if (entry.executable !== 0) {
      await chmod(target, ((await stat(target)).mode & 0o777) | entry.executable);
    }
  }
}

export async function copyOf(artifact: Artifact, specBytes: Uint8Array, check?: CheckFiles): Promise<Copy> {
  const root = await mkdtemp(join(tmpdir(), "judge-artifact-"));
  const work = join(root, "work");
  const spec = join(root, "spec", SPEC_COPY);
  const checks = join(root, CHECK_COPY);
  try {
    await mkdir(work);
    await mkdir(dirname(spec));
    await writeFile(spec, specBytes);
    await writeEntries(work, artifact.entries);
    if (check !== undefined) {
      await mkdir(checks);
      await writeEntries(check.read.single ? checks : join(checks, check.name), check.read.entries);
    }
  } catch (error) {
    await removeCopy(root);
    throw error;
  }
  const [only] = artifact.entries;
  return {
    root,
    spec,
    path: artifact.single && only !== undefined ? join(work, only.path) : work,
    check: check === undefined ? undefined : join(checks, check.name),
  };
}
