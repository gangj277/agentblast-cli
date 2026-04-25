import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles, safeReadFile, safeReadFileDetailed, searchCode } from "../src/tools/repo-tools.js";

describe("repo tools", () => {
  it("discovers files while excluding .agentblast and reads safe relative paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-repo-"));
    await mkdir(path.join(cwd, ".agentblast"), { recursive: true });
    await writeFile(path.join(cwd, "agent.ts"), "export const SYSTEM_PROMPT = 'hello';\n");
    await writeFile(path.join(cwd, ".agentblast/secret.txt"), "hidden");

    const files = await discoverFiles(cwd);
    expect(files.map((file) => file.path)).toEqual(["agent.ts"]);
    await expect(safeReadFile(cwd, "../outside")).rejects.toThrow("Unsafe relative path");
    await expect(safeReadFile(cwd, "agent.ts")).resolves.toContain("SYSTEM_PROMPT");
  });

  it("reads bounded line ranges and rejects binary files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-read-range-"));
    await writeFile(path.join(cwd, "agent.ts"), ["one", "two", "three"].join("\n"));
    await writeFile(path.join(cwd, "image.bin"), Buffer.from([0, 1, 2, 3]));

    const result = await safeReadFileDetailed(cwd, "agent.ts", { offset: 2, limit: 1 });
    expect(result).toMatchObject({
      content: "two",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true
    });
    await expect(safeReadFile(cwd, "image.bin")).rejects.toThrow("binary file");
  });

  it("rejects symlinks that resolve outside the opened workspace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-symlink-"));
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "agentblast-outside-")), "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(cwd, "linked-secret.txt"));
    await expect(safeReadFile(cwd, "linked-secret.txt")).rejects.toThrow("outside target workspace");
  });

  it("uses structured rg-backed search", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-rg-"));
    await writeFile(path.join(cwd, "agent.ts"), "const tool = 'sendEmail';\n");
    const matches = await searchCode(cwd, "sendEmail", { limit: 5 });
    expect(matches[0]).toMatchObject({ path: "agent.ts", line: 1 });
  });
});
