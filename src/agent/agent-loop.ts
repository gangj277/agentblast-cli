import { AgentModelMessage, AgentModelToolCall } from "../codex/codex-responses-client.js";
import { AgentModelClient } from "./model-client.js";
import { buildAgentSystemPrompt } from "./agent-prompt.js";
import { AgentToolCallRecord, AgentToolRegistry, createDefaultToolRegistry } from "./tool-registry.js";

export type AgentLoopResult = {
  answer: string;
  evidence: string[];
  toolCalls: AgentToolCallRecord[];
  iterations: number;
};

export type AgentLoopOptions = {
  cwd: string;
  model: string;
  userRequest: string;
  modelClient: AgentModelClient;
  registry?: AgentToolRegistry;
  maxIterations?: number;
};

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const registry = options.registry ?? createDefaultToolRegistry();
  const maxIterations = options.maxIterations ?? 8;
  const messages: AgentModelMessage[] = [
    { role: "system", content: buildAgentSystemPrompt({ cwd: options.cwd }) },
    { role: "user", content: options.userRequest }
  ];
  const toolCalls: AgentToolCallRecord[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const turn = await options.modelClient.runTurn({
      messages,
      tools: registry.toModelTools(),
      options: {
        cwd: options.cwd,
        model: options.model,
        reasoningEffort: "medium"
      }
    });

    if (turn.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: turn.content });
      return {
        answer: turn.content,
        evidence: collectEvidence(toolCalls),
        toolCalls,
        iterations: iteration
      };
    }

    messages.push({
      role: "assistant",
      content: turn.content || null,
      tool_calls: turn.toolCalls.map(toAssistantToolCall)
    });

    for (const toolCall of turn.toolCalls) {
      const parsed = tryParseToolArguments(toolCall.name, toolCall.arguments);
      const input = parsed.ok ? parsed.input : {};
      const result = parsed.ok
        ? await registry.execute(toolCall.name, input, { cwd: options.cwd })
        : {
            ok: false,
            summary: parsed.error,
            content: { error: parsed.error }
          };
      const record: AgentToolCallRecord = {
        tool: toolCall.name,
        input,
        ok: result.ok,
        summary: result.summary
      };
      toolCalls.push(record);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          ok: result.ok,
          summary: result.summary,
          content: result.content
        })
      });
    }
  }

  return {
    answer: `I reached the maximum native tool-call budget (${maxIterations}) before producing a final answer. Tool calls completed: ${toolCalls.map((call) => call.tool).join(", ") || "none"}.`,
    evidence: collectEvidence(toolCalls),
    toolCalls,
    iterations: maxIterations
  };
}

export function parseToolArguments(toolName: string, rawArguments: string): Record<string, unknown> {
  if (!rawArguments.trim()) return {};
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid arguments for tool ${toolName}: ${message}`);
  }
}

function tryParseToolArguments(
  toolName: string,
  rawArguments: string
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return { ok: true, input: parseToolArguments(toolName, rawArguments) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function toAssistantToolCall(toolCall: {
  id: string;
  name: string;
  arguments: string;
}): AgentModelToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments
    }
  };
}

function collectEvidence(toolCalls: AgentToolCallRecord[]): string[] {
  return toolCalls
    .filter((call) => call.ok)
    .map((call) => `${call.tool}: ${call.summary}`);
}
