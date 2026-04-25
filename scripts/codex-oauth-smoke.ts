import { DEFAULT_CODEX_MODEL } from "../src/codex/codex-oauth-client.js";
import { CodexResponsesClient } from "../src/codex/codex-responses-client.js";

const model = process.env.AGENTBLAST_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
const client = new CodexResponsesClient({ model, timeoutMs: 180_000 });
const status = await client.assertChatGptOAuth();
const expected = { ok: true, model, auth: "codex-oauth", tool: "agentblast_probe" };

const first = await client.call({
  model,
  messages: [
    {
      role: "system",
      content:
        "You are validating AgentBlast native Codex OAuth tool calling. First call agentblast_probe with probe='agentblast-native-tool-call'. Do not answer in text until the tool output is provided."
    },
    { role: "user", content: "Run the validation probe." }
  ],
  tools: [probeTool()]
});

const probe = first.toolCalls[0];
if (!probe || probe.name !== "agentblast_probe") {
  throw new Error(`Expected native function call agentblast_probe. Response: ${JSON.stringify(first)}`);
}

const second = await client.call({
  model,
  messages: [
    {
      role: "system",
      content: `Return exactly this JSON and nothing else after reading the tool output: ${JSON.stringify(expected)}`
    },
    { role: "user", content: "Run the validation probe." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: probe.id,
          type: "function",
          function: { name: probe.name, arguments: probe.arguments }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: probe.id,
      content: JSON.stringify({ ok: true, probe: "agentblast-native-tool-call" })
    }
  ],
  tools: [probeTool()]
});

const parsed = JSON.parse(second.content) as typeof expected;
if (parsed.ok !== true || parsed.model !== model || parsed.auth !== "codex-oauth" || parsed.tool !== "agentblast_probe") {
  throw new Error(`Codex OAuth native tool smoke test failed. Response: ${second.content}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      status: status.raw,
      model,
      auth: "codex-oauth",
      nativeTools: true,
      firstToolCall: {
        id: probe.id,
        name: probe.name,
        arguments: JSON.parse(probe.arguments)
      }
    },
    null,
    2
  )
);

function probeTool() {
  return {
    type: "function" as const,
    function: {
      name: "agentblast_probe",
      description: "Validation probe for AgentBlast native tool calling.",
      parameters: {
        type: "object",
        properties: {
          probe: { type: "string" }
        },
        required: ["probe"],
        additionalProperties: false
      }
    }
  };
}
