import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JudgeRefused } from "../src/judge-errors.js";
import { nodeArgs } from "../src/node-judge.js";
import { nodeSeccomp, SCHEDULING_SYSCALLS, SECCOMP_DEFAULT_SHA256, seccompPath, withoutScheduling } from "../src/node-seccomp.js";
import { SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";

type Rule = { names: string[]; action: string };

describe("the plain Node container's seccomp profile", () => {
  it("is Docker's default profile from the pinned file, less exactly the calls that change a task's scheduling", async () => {
    const pinned = await readFile(seccompPath());
    expect(createHash("sha256").update(pinned).digest("hex")).toBe(SECCOMP_DEFAULT_SHA256);
    const original = JSON.parse(pinned.toString("utf8")) as { defaultAction: string; syscalls: Rule[] };
    const judged = JSON.parse(await nodeSeccomp()) as { defaultAction: string; syscalls: Rule[] };
    expect(judged.defaultAction).toBe("SCMP_ACT_ERRNO");
    const allowed = (profile: { syscalls: Rule[] }) => new Set(profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW").flatMap((rule) => rule.names));
    const before = allowed(original);
    const after = allowed(judged);
    for (const name of SCHEDULING_SYSCALLS) {
      expect(before.has(name), name).toBe(true);
      expect(after.has(name), name).toBe(false);
    }
    expect([...before].filter((name) => !after.has(name)).sort()).toEqual([...SCHEDULING_SYSCALLS].sort());
    expect(judged.syscalls.filter((rule) => rule.action !== "SCMP_ACT_ALLOW")).toEqual(original.syscalls.filter((rule) => rule.action !== "SCMP_ACT_ALLOW"));
  });

  it("refuses a profile file that is missing or not the pinned one, and one that would allow what it does not list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seccomp-"));
    await expect(nodeSeccomp(join(dir, "missing.json"))).rejects.toBeInstanceOf(JudgeRefused);
    await writeFile(join(dir, "other.json"), "{}");
    await expect(nodeSeccomp(join(dir, "other.json"))).rejects.toBeInstanceOf(JudgeRefused);
    expect(() => withoutScheduling({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [] })).toThrow();
  });

  it("is passed to every plain Node container", () => {
    const args = nodeArgs({ image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: SANDBOX_TMP, gpu: false }, "judge-x", "/src", "/judge/x", "/root/seccomp.json");
    expect(args).toContain("seccomp=/root/seccomp.json");
    expect(args[args.indexOf("seccomp=/root/seccomp.json") - 1]).toBe("--security-opt");
  });
});
