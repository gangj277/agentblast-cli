import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTerminalCommand, runTerminalCommand } from "../src/tools/terminal-tools.js";
import { createDefaultToolRegistry } from "../src/agent/tool-registry.js";

describe("terminal tools", () => {
  it("runs allowed local diagnostic commands inside the opened workspace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-terminal-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));

    const result = await runTerminalCommand(cwd, {
      command: "pwd && ls",
      timeoutMs: 10_000,
      maxOutputBytes: 20_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(cwd);
    expect(result.stdout).toContain("package.json");
    expect(result.policy.allowed).toBe(true);
  });

  it("runs local Node and Python scripts plus inline diagnostics", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-terminal-scripts-"));
    await writeFile(path.join(cwd, "check.js"), "console.log('node-script-ok');\n");
    await writeFile(path.join(cwd, "check.py"), "print('python-script-ok')\n");

    const nodeScript = await runTerminalCommand(cwd, { command: "node check.js" });
    const nodeInline = await runTerminalCommand(cwd, { command: "node -e \"console.log('node-inline-ok')\"" });
    const pythonScript = await runTerminalCommand(cwd, { command: "python3 check.py" });

    expect(nodeScript).toMatchObject({ exitCode: 0, policy: { allowed: true, risk: "medium" } });
    expect(nodeScript.stdout).toContain("node-script-ok");
    expect(nodeInline).toMatchObject({ exitCode: 0, policy: { allowed: true, risk: "medium" } });
    expect(nodeInline.stdout).toContain("node-inline-ok");
    expect(pythonScript).toMatchObject({ exitCode: 0, policy: { allowed: true, risk: "medium" } });
    expect(pythonScript.stdout).toContain("python-script-ok");
  });

  it("blocks destructive, network, and credential-reading commands", async () => {
    expect(classifyTerminalCommand("rm -rf dist")).toMatchObject({ allowed: false });
    expect(classifyTerminalCommand("curl https://example.com")).toMatchObject({ allowed: false });
    expect(classifyTerminalCommand("cat ~/.codex/auth.json")).toMatchObject({ allowed: false });
  });

  it("is available through the model tool registry", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-terminal-registry-"));
    const registry = createDefaultToolRegistry();

    expect(registry.toModelTools().map((tool) => tool.function.name)).toContain("run_terminal_command");

    const result = await registry.execute("run_terminal_command", { command: "pwd" }, { cwd });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Command exited 0");
  });
});
