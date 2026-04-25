import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentModelClient, AgentModelTurn } from "../src/agent/model-client.js";
import { parseToolArguments, runAgentLoop } from "../src/agent/agent-loop.js";
import { AgentModelMessage, AgentModelTool } from "../src/codex/codex-responses-client.js";

class ScriptedModelClient implements AgentModelClient {
  readonly responses: AgentModelTurn[];
  readonly turns: Array<{ messages: AgentModelMessage[]; tools: AgentModelTool[] }> = [];

  constructor(responses: AgentModelTurn[]) {
    this.responses = [...responses];
  }

  async runTurn(input: { messages: AgentModelMessage[]; tools: AgentModelTool[] }): Promise<AgentModelTurn> {
    this.turns.push({ messages: input.messages, tools: input.tools });
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response left.");
    return response;
  }
}

describe("runAgentLoop", () => {
  it("lets the model search the opened directory and then read a selected file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentblast-agent-loop-"));
    await writeFile(
      path.join(cwd, "agent.ts"),
      [
        "export const SYSTEM_PROMPT = `You are a support agent.`;",
        "export async function sendEmailTool() { return true; }"
      ].join("\n")
    );

    const modelClient = new ScriptedModelClient([
      {
        content: "",
        toolCalls: [{ id: "call_search", name: "search_code", arguments: JSON.stringify({ query: "sendEmailTool" }) }]
      },
      {
        content: "",
        toolCalls: [{ id: "call_read", name: "read_file", arguments: JSON.stringify({ path: "agent.ts" }) }]
      },
      {
        content: "The opened directory contains agent.ts with sendEmailTool.",
        toolCalls: []
      }
    ]);

    const result = await runAgentLoop({
      cwd,
      model: "gpt-5.5",
      userRequest: "Find the email tool and read its file.",
      modelClient
    });

    expect(result.answer).toContain("sendEmailTool");
    expect(result.toolCalls.map((call) => call.tool)).toEqual(["search_code", "read_file"]);
    expect(result.toolCalls[0]?.summary).toContain("sendEmailTool");
    expect(modelClient.turns[0]?.tools.map((tool) => tool.function.name)).toContain("read_file");
    expect(modelClient.turns[0]?.tools.map((tool) => tool.function.name)).toContain("run_terminal_command");
    expect(modelClient.turns[0]?.tools.map((tool) => tool.function.name)).toContain("red_team_agent");
    expect(modelClient.turns[1]?.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_search")).toBe(true);
  });
});

describe("parseToolArguments", () => {
  it("parses native function-call argument strings", () => {
    expect(parseToolArguments("list_files", '{"limit":5}')).toEqual({ limit: 5 });
  });
});
