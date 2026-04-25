import { AgentMap } from "../core/types.js";
import { RepoFile, SearchMatch } from "../tools/repo-tools.js";

export function buildAgentBlastPrompt(input: {
  question: string;
  cwd: string;
  agentMap: AgentMap;
  files: RepoFile[];
  matches: SearchMatch[];
}): string {
  return [
    "You are Agent Blast, a defensive local-code AI agent security engineer.",
    "Work only on the user's owned local codebase. Do not provide offensive instructions against third-party systems.",
    "Use first principles: identify the agent boundary, untrusted inputs, trusted instructions, data access, tools, and side effects.",
    "Ground every concrete claim in the provided codebase map or file/search evidence.",
    "Never claim the system is fully safe. Only state replay-backed or evidence-backed conclusions.",
    "",
    `Target cwd: ${input.cwd}`,
    "",
    "Agent map:",
    JSON.stringify(input.agentMap, null, 2),
    "",
    "Relevant files:",
    input.files
      .slice(0, 120)
      .map((file) => `- ${file.path}`)
      .join("\n"),
    "",
    "Search evidence:",
    input.matches.map((match) => `- ${match.path}:${match.line}: ${match.text}`).join("\n") || "No search matches.",
    "",
    "User instruction:",
    input.question,
    "",
    "Answer with concise, source-grounded engineering guidance. If code changes are needed, describe the intended patch and the replay check."
  ].join("\n");
}
