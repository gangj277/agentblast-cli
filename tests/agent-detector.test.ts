import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectAgent } from "../src/inspect/agent-detector.js";
import { generateFindings } from "../src/scan/finding-engine.js";

describe("inspectAgent", () => {
  it("detects a TypeScript agent route, prompt, model call, tool, and retrieval surface", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-fixture-"));
    await mkdir(path.join(cwd, "app/api/agent"), { recursive: true });
    await mkdir(path.join(cwd, "lib/agent"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ dependencies: { next: "latest" } }));
    await writeFile(
      path.join(cwd, "app/api/agent/route.ts"),
      [
        "import OpenAI from 'openai';",
        "import { SYSTEM_PROMPT } from '../../../lib/agent/prompt';",
        "export async function POST() {",
        "  const openai = new OpenAI();",
        "  return openai.chat.completions.create({ model: 'gpt-5.5', messages: [{ role: 'system', content: SYSTEM_PROMPT }] });",
        "}"
      ].join("\n")
    );
    await writeFile(path.join(cwd, "lib/agent/prompt.ts"), "export const SYSTEM_PROMPT = `You are a support agent.`;\n");
    await writeFile(path.join(cwd, "lib/agent/tools.ts"), "export async function sendEmailTool() { return true; }\n");
    await writeFile(path.join(cwd, "lib/agent/rag.ts"), "export async function retrieveDocs() { return vectorStore.similaritySearch('x'); }\n");

    const agentMap = await inspectAgent(cwd);
    expect(agentMap.project.framework).toBe("node");
    expect(agentMap.entrypoints).toHaveLength(1);
    expect(agentMap.modelCalls.length).toBeGreaterThan(0);
    expect(agentMap.prompts.length).toBeGreaterThan(0);
    expect(agentMap.tools.some((tool) => tool.name === "sendEmailTool" && tool.sideEffect)).toBe(true);
    expect(agentMap.retrieval.length).toBeGreaterThan(0);

    const findings = generateFindings(agentMap);
    expect(findings.some((finding) => finding.category === "unsafe_tool_invocation")).toBe(true);
    expect(findings.some((finding) => finding.category === "instruction_boundary")).toBe(true);
  });
});
