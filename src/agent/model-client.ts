import {
  AgentModelMessage,
  AgentModelTool,
  AgentModelUsage,
  AccumulatedToolCall,
  CodexResponsesClient,
  ReasoningEffort
} from "../codex/codex-responses-client.js";

export type AgentModelOptions = {
  cwd: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
};

export type AgentModelTurn = {
  content: string;
  toolCalls: AccumulatedToolCall[];
  usage?: AgentModelUsage;
};

export interface AgentModelClient {
  runTurn(input: {
    messages: AgentModelMessage[];
    tools: AgentModelTool[];
    options: AgentModelOptions;
  }): Promise<AgentModelTurn>;
}

export class CodexAgentModelClient implements AgentModelClient {
  readonly codex: CodexResponsesClient;

  constructor(codex: CodexResponsesClient) {
    this.codex = codex;
  }

  async runTurn(input: {
    messages: AgentModelMessage[];
    tools: AgentModelTool[];
    options: AgentModelOptions;
  }): Promise<AgentModelTurn> {
    return this.codex.call({
      messages: input.messages,
      tools: input.tools,
      reasoningEffort: input.options.reasoningEffort ?? "medium",
      model: input.options.model
    });
  }
}
