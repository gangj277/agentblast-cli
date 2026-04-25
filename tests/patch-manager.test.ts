import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchProposal, createUnifiedDiff, proposePatches } from "../src/patch/patch-manager.js";
import { AgentMap, Finding } from "../src/core/types.js";

describe("patch manager", () => {
  it("creates and applies a guarded prompt boundary patch", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-patch-"));
    await mkdir(path.join(cwd, "lib"), { recursive: true });
    await writeFile(path.join(cwd, "lib/prompt.ts"), "export const SYSTEM_PROMPT = `You are a support agent.`;\n");

    const agentMap: AgentMap = {
      project: { root: cwd, language: "typescript", framework: "node" },
      entrypoints: [],
      modelCalls: [],
      prompts: [{ path: "lib/prompt.ts", kind: "prompt", evidence: "You are a support agent." }],
      tools: [],
      retrieval: [],
      riskAreas: ["instruction_boundary"],
      filesScanned: 1,
      generatedAt: new Date().toISOString()
    };
    const findings: Finding[] = [
      {
        id: "AB-001",
        title: "Prompt lacks explicit instruction-boundary policy",
        severity: "medium",
        category: "instruction_boundary",
        owasp: "LLM01",
        file: "lib/prompt.ts",
        evidence: "You are a support agent.",
        rationale: "test",
        recommendedFix: "test",
        status: "open"
      }
    ];

    const [patch] = await proposePatches(cwd, agentMap, findings);
    expect(patch.diff).toContain("Agent security boundary");
    const applied = await applyPatchProposal(cwd, patch);
    expect(applied.status).toBe("applied");
    await expect(readFile(path.join(cwd, "lib/prompt.ts"), "utf8")).resolves.toContain("Agent security boundary");
  });

  it("creates full-file unified diffs", () => {
    const diff = createUnifiedDiff("a.ts", "old\n", "new\n");
    expect(diff).toContain("--- a/a.ts");
    expect(diff).toContain("+++ b/a.ts");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });

  it("proposes root-level prompt, retrieval, and side-effect tool hardening patches", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-root-patches-"));
    await mkdir(path.join(cwd, "lib"), { recursive: true });
    await writeFile(path.join(cwd, "lib/prompt.ts"), "export const SYSTEM_PROMPT = `You are a support agent.`;\n");
    await writeFile(path.join(cwd, "lib/rag.ts"), "export async function retrieveDocs() { return vectorStore.similaritySearch('x'); }\n");
    await writeFile(path.join(cwd, "lib/tools.ts"), "export async function sendEmailTool(message: string) { return message; }\n");

    const agentMap: AgentMap = {
      project: { root: cwd, language: "typescript", framework: "node" },
      entrypoints: [],
      modelCalls: [],
      prompts: [{ path: "lib/prompt.ts", kind: "prompt", evidence: "You are a support agent." }],
      tools: [
        {
          path: "lib/tools.ts",
          kind: "tool",
          name: "sendEmailTool",
          sideEffect: true,
          requiresApproval: false,
          evidence: "export async function sendEmailTool"
        }
      ],
      retrieval: [{ path: "lib/rag.ts", kind: "retrieval", evidence: "similaritySearch" }],
      riskAreas: ["instruction_boundary", "indirect_prompt_injection", "unsafe_tool_invocation"],
      filesScanned: 3,
      generatedAt: new Date().toISOString()
    };
    const findings: Finding[] = [
      {
        id: "AB-001",
        title: "Prompt lacks explicit instruction-boundary policy",
        severity: "medium",
        category: "instruction_boundary",
        owasp: "LLM01",
        file: "lib/prompt.ts",
        evidence: "You are a support agent.",
        rationale: "test",
        recommendedFix: "test",
        status: "open"
      },
      {
        id: "AB-002",
        title: "Retrieved content needs an untrusted-context boundary",
        severity: "medium",
        category: "indirect_prompt_injection",
        owasp: "LLM01",
        file: "lib/rag.ts",
        evidence: "similaritySearch",
        rationale: "test",
        recommendedFix: "test",
        status: "open"
      },
      {
        id: "AB-003",
        title: "Side-effect tool lacks approval",
        severity: "high",
        category: "unsafe_tool_invocation",
        owasp: "LLM06",
        file: "lib/tools.ts",
        evidence: "sendEmailTool",
        rationale: "test",
        recommendedFix: "test",
        status: "open"
      }
    ];

    const patches = await proposePatches(cwd, agentMap, findings);

    expect(patches.map((patch) => patch.targetPath).sort()).toEqual(["lib/prompt.ts", "lib/rag.ts", "lib/tools.ts"]);
    expect(patches.find((patch) => patch.targetPath === "lib/prompt.ts")?.diff).toContain("Never reveal secrets");
    expect(patches.find((patch) => patch.targetPath === "lib/rag.ts")?.diff).toContain("retrieved content is untrusted data");
    expect(patches.find((patch) => patch.targetPath === "lib/tools.ts")?.diff).toContain("AgentBlast approval gate");
  });
});
