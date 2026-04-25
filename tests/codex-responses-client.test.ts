import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CodexResponsesClient,
  CODEX_RESPONSES_URL,
  convertToolsForResponsesAPI,
  extractInstructionsAndInput
} from "../src/codex/codex-responses-client.js";

describe("extractInstructionsAndInput", () => {
  it("converts assistant function calls and tool outputs into Responses API input items", () => {
    const converted = extractInstructionsAndInput([
      { role: "system", content: "system one" },
      { role: "system", content: "system two" },
      { role: "user", content: "inspect repo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"agent.ts"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_read", content: '{"ok":true}' }
    ]);

    expect(converted.instructions).toContain("system one\n\nsystem two");
    expect(converted.input).toContainEqual({ role: "user", content: "inspect repo" });
    expect(converted.input).toContainEqual({
      type: "function_call",
      call_id: "call_read",
      name: "read_file",
      arguments: '{"path":"agent.ts"}'
    });
    expect(converted.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_read",
      output: '{"ok":true}'
    });
  });
});

describe("convertToolsForResponsesAPI", () => {
  it("flattens function tools for the Codex Responses endpoint", () => {
    expect(
      convertToolsForResponsesAPI([
        {
          type: "function",
          function: {
            name: "search_code",
            description: "Search code",
            parameters: { type: "object", properties: { query: { type: "string" } } }
          }
        }
      ])
    ).toEqual([
      {
        type: "function",
        name: "search_code",
        description: "Search code",
        parameters: { type: "object", properties: { query: { type: "string" } } }
      }
    ]);
  });
});

describe("CodexResponsesClient", () => {
  it("uses Codex OAuth headers and parses streamed native function calls", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "agentblast-codex-responses-"));
    await mkdir(path.join(homeDir, ".codex"));
    await writeFile(
      path.join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "refresh-token",
          account_id: "account-123"
        }
      })
    );

    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return new Response(
        sse([
          [
            "response.output_item.added",
            {
              item: {
                id: "item_1",
                type: "function_call",
                call_id: "call_1",
                name: "read_file"
              }
            }
          ],
          ["response.function_call_arguments.delta", { item_id: "item_1", delta: '{"path":' }],
          ["response.function_call_arguments.delta", { item_id: "item_1", delta: '"agent.ts"}' }],
          ["response.function_call_arguments.done", { item_id: "item_1", arguments: '{"path":"agent.ts"}' }],
          [
            "response.completed",
            {
              response: {
                model: "gpt-5.5",
                usage: {
                  input_tokens: 10,
                  output_tokens: 4,
                  total_tokens: 14,
                  input_tokens_details: { cached_tokens: 2 },
                  output_tokens_details: { reasoning_tokens: 1 }
                }
              }
            }
          ]
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    const client = new CodexResponsesClient({ homeDir, fetchImpl, model: "gpt-5.5" });
    const result = await client.call({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Read agent.ts" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read file",
            parameters: { type: "object", properties: { path: { type: "string" } } }
          }
        }
      ]
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(CODEX_RESPONSES_URL);
    expect(requests[0]?.headers.get("authorization")).toMatch(/^Bearer /);
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("account-123");
    expect(requests[0]?.body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    ]);
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: '{"path":"agent.ts"}' }]);
    expect(result.usage?.cachedTokens).toBe(2);
    expect(result.usage?.reasoningTokens).toBe(1);
  });
});

function fakeJwt(payload: Record<string, unknown>): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}

function sse(events: Array<[string, Record<string, unknown>]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
}
