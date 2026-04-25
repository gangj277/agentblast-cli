import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_CODEX_MODEL } from "./codex-oauth-client.js";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type AgentModelTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentModelToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AgentModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: AgentModelToolCall[];
  tool_call_id?: string;
};

export type AccumulatedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type AgentModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
};

export type AgentStreamChunk =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; arguments: string }
  | { type: "done"; content: string; toolCalls: AccumulatedToolCall[]; usage?: AgentModelUsage };

export type CodexAuthStatus = {
  loggedIn: boolean;
  provider: "chatgpt" | "none";
  accountId?: string;
  expiresAt?: number;
  raw: string;
};

export type CodexResponsesClientOptions = {
  model?: string;
  homeDir?: string;
  authFilePath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  originator?: string;
  userAgent?: string;
};

export type CodexResponsesCallOptions = {
  messages: AgentModelMessage[];
  tools?: AgentModelTool[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
};

type CodexAuthFile = {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
};

type LoadedCodexCredentials = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
};

type ResponsesInputItem = Record<string, unknown>;

export class CodexResponsesClient {
  readonly model: string;
  readonly timeoutMs: number;
  readonly authFilePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly originator: string;
  private readonly userAgent: string;
  private credentials?: LoadedCodexCredentials;
  private readonly sessionId = randomUUID();

  constructor(options: CodexResponsesClientOptions = {}) {
    this.model = options.model ?? process.env.AGENTBLAST_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.originator = options.originator ?? "agentblast";
    this.userAgent = options.userAgent ?? `agentblast-cli/0.1.0 (${process.platform} ${process.arch})`;
    this.authFilePath =
      options.authFilePath ??
      path.join(options.homeDir ?? process.env.HOME ?? "", ".codex", "auth.json");
  }

  async getAuthStatus(): Promise<CodexAuthStatus> {
    try {
      const credentials = await this.loadCredentials();
      return {
        loggedIn: true,
        provider: "chatgpt",
        accountId: credentials.accountId,
        expiresAt: credentials.expiresAt,
        raw: "Logged in using ChatGPT"
      };
    } catch (error) {
      return {
        loggedIn: false,
        provider: "none",
        raw: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async assertChatGptOAuth(): Promise<CodexAuthStatus> {
    const status = await this.getAuthStatus();
    if (!status.loggedIn) {
      throw new Error(`Codex OAuth is not ready. ${status.raw}`);
    }
    return status;
  }

  async call(options: CodexResponsesCallOptions): Promise<{
    content: string;
    toolCalls: AccumulatedToolCall[];
    usage?: AgentModelUsage;
  }> {
    let content = "";
    let toolCalls: AccumulatedToolCall[] = [];
    let usage: AgentModelUsage | undefined;

    for await (const chunk of this.callStreaming(options)) {
      if (chunk.type === "text_delta") {
        content += chunk.content;
      } else if (chunk.type === "done") {
        content = chunk.content;
        toolCalls = chunk.toolCalls;
        usage = chunk.usage;
      }
    }

    return { content, toolCalls, usage };
  }

  async *callStreaming(options: CodexResponsesCallOptions): AsyncGenerator<AgentStreamChunk> {
    const { instructions, input } = extractInstructionsAndInput(options.messages);
    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      instructions,
      input,
      store: false,
      stream: true
    };

    if (options.reasoningEffort && options.reasoningEffort !== "none") {
      body.reasoning = { effort: options.reasoningEffort };
    }

    const tools = convertToolsForResponsesAPI(options.tools);
    if (tools) body.tools = tools;

    const response = await this.performRequest(body, options.signal);
    if (!response.ok) {
      throw new Error(`Codex Responses API ${response.status}: ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error("Codex Responses API returned no response body.");
    }

    let fullContent = "";
    let usage: AgentModelUsage | undefined;
    const toolCallsByItemId = new Map<string, { index: number; call: AccumulatedToolCall }>();
    let toolCallIndex = 0;

    for await (const event of parseResponsesSSE(response.body)) {
      switch (event.type) {
        case "response.output_text.delta": {
          const delta = typeof event.data.delta === "string" ? event.data.delta : "";
          fullContent += delta;
          yield { type: "text_delta", content: delta };
          break;
        }

        case "response.output_item.added": {
          const item = event.data.item;
          if (isRecord(item) && item.type === "function_call") {
            const itemId = readOptionalString(item.id) ?? readOptionalString(item.call_id) ?? `item_${toolCallIndex}`;
            const callId = readOptionalString(item.call_id) ?? `call_${toolCallIndex}`;
            const name = readOptionalString(item.name) ?? "";
            const index = toolCallIndex;
            toolCallIndex += 1;
            toolCallsByItemId.set(itemId, {
              index,
              call: { id: callId, name, arguments: "" }
            });
            if (name) {
              yield { type: "tool_call_start", index, id: callId, name };
            }
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const itemId = readOptionalString(event.data.item_id) ?? "";
          const delta = readOptionalString(event.data.delta) ?? "";
          const entry = toolCallsByItemId.get(itemId);
          if (entry) {
            entry.call.arguments += delta;
            yield { type: "tool_call_delta", index: entry.index, arguments: delta };
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const itemId = readOptionalString(event.data.item_id) ?? "";
          const args = readOptionalString(event.data.arguments) ?? "";
          const entry = toolCallsByItemId.get(itemId);
          if (entry) {
            entry.call.arguments = args;
          }
          break;
        }

        case "response.completed": {
          const responsePayload = event.data.response;
          if (isRecord(responsePayload) && isRecord(responsePayload.usage)) {
            usage = parseUsage(responsePayload.usage);
          }
          break;
        }
      }
    }

    const toolCalls = [...toolCallsByItemId.values()]
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.call);

    yield {
      type: "done",
      content: fullContent,
      toolCalls,
      usage
    };
  }

  private async performRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let token = await this.ensureValidToken();
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await this.fetchImpl(CODEX_RESPONSES_URL, {
          method: "POST",
          headers: this.buildHeaders(token),
          body: JSON.stringify(body),
          signal: controller.signal
        });
        lastResponse = response;

        if (response.status === 401 && attempt === 0) {
          token = await this.ensureValidToken(true);
          continue;
        }

        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await sleep(250 * 2 ** attempt);
          continue;
        }

        return response;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    return lastResponse ?? new Response("Codex Responses API request failed", { status: 500 });
  }

  private buildHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      originator: this.originator,
      "User-Agent": this.userAgent,
      session_id: this.sessionId
    };
    if (this.credentials?.accountId) {
      headers["ChatGPT-Account-Id"] = this.credentials.accountId;
    }
    return headers;
  }

  private async ensureValidToken(forceRefresh = false): Promise<string> {
    const current = this.credentials ?? (await this.loadCredentials());
    this.credentials = current;

    if (!forceRefresh && current.expiresAt - Date.now() >= 30_000) {
      return current.accessToken;
    }

    const refreshed = await refreshAccessToken(current.refreshToken, this.fetchImpl);
    this.credentials = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || current.refreshToken,
      accountId: current.accountId,
      expiresAt: Date.now() + refreshed.expires_in * 1000
    };
    return this.credentials.accessToken;
  }

  private async loadCredentials(): Promise<LoadedCodexCredentials> {
    const parsed = JSON.parse(await readFile(this.authFilePath, "utf8")) as CodexAuthFile;
    if (parsed.auth_mode !== "chatgpt") {
      throw new Error("Codex is not signed in with ChatGPT OAuth on this device.");
    }

    const accessToken = assertString(parsed.tokens?.access_token, "Codex auth is missing an access token.");
    const refreshToken = assertString(parsed.tokens?.refresh_token, "Codex auth is missing a refresh token.");
    const accountId = assertString(parsed.tokens?.account_id, "Codex auth is missing an account ID.");
    return {
      accessToken,
      refreshToken,
      accountId,
      expiresAt: getTokenExpiryMs(accessToken)
    };
  }
}

export function extractInstructionsAndInput(messages: AgentModelMessage[]): {
  instructions: string;
  input: ResponsesInputItem[];
} {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) instructions.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: message.content ?? ""
      });
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        });
      }
      if (message.content) {
        input.push({ role: "assistant", content: message.content });
      }
      continue;
    }

    input.push({ role: message.role, content: message.content ?? "" });
  }

  return {
    instructions: instructions.join("\n\n") || "You are a helpful assistant.",
    input
  };
}

export function convertToolsForResponsesAPI(tools?: AgentModelTool[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
}

export async function* parseResponsesSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{
  type: string;
  data: Record<string, unknown>;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
        } else if (trimmed.startsWith("data: ")) {
          try {
            const data = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
            yield { type: currentEvent || readOptionalString(data.type) || "", data };
          } catch {
            // Ignore malformed SSE data frames.
          }
        } else if (trimmed === "") {
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT format.");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function getTokenExpiryMs(token: string): number {
  const payload = decodeJwtPayload(token);
  if (typeof payload.exp !== "number") {
    throw new Error("Codex access token is missing an expiry.");
  }
  return payload.exp * 1000;
}

async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const response = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_CLIENT_ID,
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

function parseUsage(usage: Record<string, unknown>): AgentModelUsage {
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const promptTokens = readNumber(usage.input_tokens);
  const completionTokens = readNumber(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: readNumber(usage.total_tokens) || promptTokens + completionTokens,
    cachedTokens: readNumber(inputDetails.cached_tokens),
    reasoningTokens: readNumber(outputDetails.reasoning_tokens)
  };
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
