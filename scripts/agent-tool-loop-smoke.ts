import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop } from "../src/agent/agent-loop.js";
import { AgentModelClient, AgentModelTurn } from "../src/agent/model-client.js";
import { AgentModelMessage, AgentModelTool } from "../src/codex/codex-responses-client.js";

class ScriptedModelClient implements AgentModelClient {
  private responses: AgentModelTurn[];
  readonly observed: Array<{ messages: AgentModelMessage[]; tools: AgentModelTool[] }> = [];

  constructor(responses: AgentModelTurn[]) {
    this.responses = [...responses];
  }

  async runTurn(input: { messages: AgentModelMessage[]; tools: AgentModelTool[] }): Promise<AgentModelTurn> {
    this.observed.push({ messages: input.messages, tools: input.tools });
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response available.");
    return response;
  }
}

const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-tool-loop-smoke-"));
await writeFile(
  path.join(cwd, "agent.ts"),
  [
    "export const SYSTEM_PROMPT = `You are an AI support agent.`;",
    "export async function sendEmailTool() { return true; }"
  ].join("\n")
);

const result = await runAgentLoop({
  cwd,
  model: "gpt-5.5",
  userRequest: "Search for the email tool and read the file that defines it.",
  modelClient: new ScriptedModelClient([
    {
      content: "",
      toolCalls: [{ id: "call_search", name: "search_code", arguments: JSON.stringify({ query: "sendEmailTool" }) }]
    },
    {
      content: "",
      toolCalls: [{ id: "call_read", name: "read_file", arguments: JSON.stringify({ path: "agent.ts" }) }]
    },
    {
      content: "",
      toolCalls: [{ id: "call_terminal", name: "run_terminal_command", arguments: JSON.stringify({ command: "pwd" }) }]
    },
    {
      content: "",
      toolCalls: [{ id: "call_redteam", name: "red_team_agent", arguments: JSON.stringify({ mode: "quick", maxCases: 8 }) }]
    },
    {
      content: "I searched the opened directory, read agent.ts, ran pwd in the terminal, and executed the local red-team harness.",
      toolCalls: []
    }
  ])
});

const tools = result.toolCalls.map((call) => call.tool);
if (tools.join(",") !== "search_code,read_file,run_terminal_command,red_team_agent") {
  throw new Error(`Expected search_code then read_file then run_terminal_command then red_team_agent, got ${tools.join(",")}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      cwd,
      answer: result.answer,
      toolCalls: result.toolCalls
    },
    null,
    2
  )
);
