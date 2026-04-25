import { AgentMap, AgentSurface, ToolSurface } from "../core/types.js";
import { detectFramework, detectLanguage, discoverFiles, readRelevantFiles } from "../tools/repo-tools.js";

export async function inspectAgent(cwd: string): Promise<AgentMap> {
  const files = await discoverFiles(cwd);
  const contents = await readRelevantFiles(cwd, files);
  const entrypoints: AgentSurface[] = [];
  const modelCalls: AgentSurface[] = [];
  const prompts: AgentSurface[] = [];
  const tools: ToolSurface[] = [];
  const retrieval: AgentSurface[] = [];

  for (const file of files) {
    if (!isCandidateAgentFile(file.path)) continue;
    const content = contents.get(file.path);
    if (!content) continue;

    if (isEntrypoint(file.path, content)) {
      entrypoints.push(surface(file.path, "entrypoint", summarizeEvidence(content, /(POST|GET|handler|route|api|server action)/i)));
    }
    if (hasModelCall(content)) {
      modelCalls.push(surface(file.path, "model_call", summarizeEvidence(content, /(openai|generateText|streamText|chat\.completions|responses\.create|anthropic|langchain)/i)));
    }
    if (hasPrompt(content, file.path)) {
      prompts.push(surface(file.path, "prompt", summarizePromptEvidence(content)));
    }
    if (hasRetrieval(content, file.path)) {
      retrieval.push(surface(file.path, "retrieval", summarizeEvidence(content, /(retriev|rag|vector|embedding|similaritySearch|searchDocs|knowledge)/i)));
    }
    for (const tool of detectTools(file.path, content)) {
      tools.push(tool);
    }
  }

  const riskAreas = inferRiskAreas({ prompts, tools, retrieval });

  return {
    project: {
      root: cwd,
      language: detectLanguage(files),
      framework: detectFramework(files)
    },
    entrypoints: dedupeSurfaces(entrypoints),
    modelCalls: dedupeSurfaces(modelCalls),
    prompts: dedupeSurfaces(prompts),
    tools: dedupeTools(tools),
    retrieval: dedupeSurfaces(retrieval),
    riskAreas,
    filesScanned: files.length,
    generatedAt: new Date().toISOString()
  };
}

function isEntrypoint(filePath: string, content: string): boolean {
  return (
    /(^|\/)(app\/api\/.+\/route|pages\/api\/|api\/|routes\/|server\/routes\/)/.test(filePath) ||
    /export\s+async\s+function\s+(POST|GET|PUT|PATCH)/.test(content)
  );
}

function hasModelCall(content: string): boolean {
  return /(openai|@ai-sdk|generateText|streamText|chat\.completions|responses\.create|anthropic|ChatOpenAI|langchain)/i.test(content);
}

function hasPrompt(content: string, filePath: string): boolean {
  return /prompt/i.test(filePath) || /(systemPrompt|developerPrompt|SYSTEM_PROMPT|messages\s*:\s*\[\s*{\s*role:\s*["']system["'])/.test(content);
}

function hasRetrieval(content: string, filePath: string): boolean {
  return /rag|retriev|vector|embedding|knowledge/i.test(filePath) || /(similaritySearch\s*\(|vectorStore\.|retrieve[A-Z][A-Za-z0-9_]*\s*\(|searchDocs\s*\(|knowledgeBase\.)/i.test(content);
}

function detectTools(filePath: string, content: string): ToolSurface[] {
  const candidates = new Set<string>();
  const hasExplicitToolDeclaration = /tool\s*\(|tools\s*:|functionTool|defineTool|createTool/i.test(content);
  const toolRegexes = [
    /tool\s*\(\s*{\s*name:\s*["']([^"']+)["']/g,
    /(?:async\s+)?function\s+([A-Za-z0-9_]*(?:Tool|Email|Ticket|Customer|Query|Create|Delete|Update)[A-Za-z0-9_]*)\s*\(/g,
    /const\s+([A-Za-z0-9_]*(?:Tool|Email|Ticket|Customer|Query|Create|Delete|Update)[A-Za-z0-9_]*)\s*=/g
  ];

  for (const regex of hasExplicitToolDeclaration || /tool/i.test(filePath) ? toolRegexes : []) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content))) {
      if (match[1]) candidates.add(match[1]);
    }
  }

  return Array.from(candidates).map((name) => {
    const sideEffect = /(send|email|create|delete|update|write|post|webhook|refund|purchase|ticket)/i.test(name + content.slice(0, 400));
    const requiresApproval = /(approval|requiredConfirmation|confirm|humanReview|requiresApproval)/i.test(content);
    return {
      path: filePath,
      kind: "tool",
      name,
      sideEffect,
      requiresApproval,
      evidence: summarizeEvidence(content, new RegExp(escapeRegExp(name), "i"))
    };
  });
}

function isCandidateAgentFile(filePath: string): boolean {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) return false;
  if (/(^|\/)(tests?|__tests__|fixtures?|mocks?)\//i.test(filePath)) return false;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(filePath)) return false;
  if (/\.d\.ts$/i.test(filePath)) return false;
  if (/(agent-detector|finding-engine|patch-manager|repo-tools|AgentBlastApp)/.test(filePath)) return false;
  return true;
}

function surface(path: string, kind: string, evidence: string): AgentSurface {
  return { path, kind, evidence };
}

function summarizeEvidence(content: string, regex: RegExp): string {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => regex.test(line));
  if (index === -1) return lines.slice(0, 2).join(" ").trim().slice(0, 180);
  return lines
    .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 220);
}

function summarizePromptEvidence(content: string): string {
  const boundaryRegex = /(untrusted|external content|retrieved content|tool output|terminal output|cannot override|trusted instructions|ignore instructions from)/i;
  if (content.split("\n").some((line) => boundaryRegex.test(line))) {
    return summarizeEvidence(content, boundaryRegex);
  }
  return summarizeEvidence(content, /(systemPrompt|developerPrompt|SYSTEM_PROMPT|messages\s*:\s*\[\s*{\s*role:\s*["']system["'])/i);
}

function inferRiskAreas(input: {
  prompts: AgentSurface[];
  tools: ToolSurface[];
  retrieval: AgentSurface[];
}): string[] {
  const risks = new Set<string>();
  if (input.prompts.length > 0) risks.add("instruction_boundary");
  if (input.retrieval.length > 0) risks.add("indirect_prompt_injection");
  if (input.tools.some((tool) => tool.sideEffect)) risks.add("unsafe_tool_invocation");
  if (input.tools.some((tool) => tool.sideEffect && !tool.requiresApproval)) risks.add("excessive_agency");
  return Array.from(risks);
}

function dedupeSurfaces<T extends AgentSurface>(surfaces: T[]): T[] {
  const seen = new Set<string>();
  return surfaces.filter((surface) => {
    const key = `${surface.path}:${surface.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeTools(tools: ToolSurface[]): ToolSurface[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    const key = `${tool.path}:${tool.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
