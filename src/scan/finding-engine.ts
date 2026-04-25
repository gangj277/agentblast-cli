import { AgentMap, Finding } from "../core/types.js";

export function generateFindings(agentMap: AgentMap): Finding[] {
  const findings: Finding[] = [];

  for (const tool of agentMap.tools) {
    if (tool.sideEffect && !tool.requiresApproval) {
      findings.push({
        id: createFindingId(findings.length),
        title: `Side-effect tool "${tool.name}" lacks an approval gate`,
        severity: "high",
        category: "unsafe_tool_invocation",
        owasp: "LLM06",
        file: tool.path,
        evidence: tool.evidence,
        rationale: "A prompt-injected or confused agent should not be able to perform external writes/sends without a non-model authorization boundary.",
        recommendedFix: "Require explicit human approval or a deterministic policy check before this tool can execute.",
        status: "open"
      });
    }
  }

  for (const retrieval of agentMap.retrieval) {
    if (!hasInstructionBoundary(retrieval.evidence)) {
      findings.push({
        id: createFindingId(findings.length),
        title: "Retrieved content needs an untrusted-context boundary",
        severity: "medium",
        category: "indirect_prompt_injection",
        owasp: "LLM01",
        file: retrieval.path,
        evidence: retrieval.evidence,
        rationale: "RAG/tool outputs are untrusted data. If they enter the model context without provenance and boundary instructions, they can steer agent behavior.",
        recommendedFix: "Wrap retrieved content as untrusted evidence and state that it cannot override system, developer, or user instructions.",
        status: "open"
      });
    }
  }

  for (const prompt of promptSurfacesForFindings(agentMap)) {
    if (!hasInstructionBoundary(prompt.evidence)) {
      findings.push({
        id: createFindingId(findings.length),
        title: "Prompt lacks explicit instruction-boundary policy",
        severity: "medium",
        category: "instruction_boundary",
        owasp: "LLM01",
        file: prompt.path,
        evidence: prompt.evidence,
        rationale: "Agent prompts should explicitly distinguish trusted instructions from untrusted content, especially when tools or retrieval are present.",
        recommendedFix: "Add a concise instruction hierarchy clause covering untrusted user/retrieved/tool content.",
        status: "open"
      });
    }
  }

  if (agentMap.modelCalls.length > 0 && agentMap.tools.length === 0 && agentMap.retrieval.length === 0 && findings.length === 0) {
    findings.push({
      id: createFindingId(findings.length),
      title: "Model call found, but no agent tools or retrieval detected",
      severity: "info",
      category: "coverage_gap",
      owasp: "N/A",
      evidence: agentMap.modelCalls[0]?.evidence ?? "Model call detected",
      rationale: "Agent Blast can inspect this model path, but deeper red-team checks require tool, retrieval, or policy surfaces.",
      recommendedFix: "Confirm whether tools/retrieval are defined dynamically or outside the scanned source tree.",
      status: "open"
    });
  }

  return findings;
}

function hasInstructionBoundary(evidence: string): boolean {
  return /untrusted|external content|retrieved content|tool output|terminal output|cannot override|ignore instructions from|trusted instructions/i.test(evidence);
}

function promptSurfacesForFindings(agentMap: AgentMap) {
  const dedicatedPromptSurfaces = agentMap.prompts.filter((surface) =>
    /(^|\/)(prompts?|system-prompt|developer-prompt|agent\/prompt)\b|prompt\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(surface.path)
  );
  return dedicatedPromptSurfaces.length > 0 ? dedicatedPromptSurfaces : agentMap.prompts;
}

function createFindingId(index: number): string {
  return `AB-${String(index + 1).padStart(3, "0")}`;
}
