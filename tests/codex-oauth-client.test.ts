import { describe, expect, it } from "vitest";
import {
  buildCodexExecArgs,
  parseCodexJsonEvent,
  parseCodexLoginStatus,
  sanitizedCodexEnv
} from "../src/codex/codex-oauth-client.js";

describe("parseCodexLoginStatus", () => {
  it("detects ChatGPT OAuth login", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT")).toEqual({
      loggedIn: true,
      provider: "chatgpt",
      raw: "Logged in using ChatGPT"
    });
  });

  it("detects API-key login separately", () => {
    expect(parseCodexLoginStatus("Logged in using API key").provider).toBe("api-key");
  });

  it("treats not logged in as unavailable", () => {
    expect(parseCodexLoginStatus("Not logged in")).toMatchObject({
      loggedIn: false,
      provider: "none"
    });
  });
});

describe("buildCodexExecArgs", () => {
  it("uses gpt-5.5-compatible non-interactive Codex flags", () => {
    const args = buildCodexExecArgs({
      model: "gpt-5.5",
      outputFile: "/tmp/agentblast-last-message.txt",
      prompt: "hello"
    });

    expect(args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--model",
      "gpt-5.5",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "/tmp/agentblast-last-message.txt",
      "hello"
    ]);
  });

  it("supports JSON event streaming mode", () => {
    const args = buildCodexExecArgs({
      model: "gpt-5.5",
      outputFile: "/tmp/agentblast-last-message.txt",
      prompt: "hello",
      sandbox: "workspace-write",
      json: true
    });

    expect(args).toContain("--json");
    expect(args).toContain("workspace-write");
  });
});

describe("parseCodexJsonEvent", () => {
  it("parses Codex JSONL events and ignores non-JSON warnings", () => {
    expect(parseCodexJsonEvent('{"type":"turn.completed","usage":{"input_tokens":1}}')).toMatchObject({
      type: "turn.completed"
    });
    expect(parseCodexJsonEvent("2026 WARN plugin failed")).toBeUndefined();
  });
});

describe("sanitizedCodexEnv", () => {
  it("removes direct model-provider API keys so AgentBlast uses Codex OAuth", () => {
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
    };

    process.env.OPENAI_API_KEY = "should-not-be-used";
    process.env.OPENROUTER_API_KEY = "should-not-be-used";
    process.env.ANTHROPIC_API_KEY = "should-not-be-used";

    try {
      const env = sanitizedCodexEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      restoreEnv("OPENAI_API_KEY", previous.OPENAI_API_KEY);
      restoreEnv("OPENROUTER_API_KEY", previous.OPENROUTER_API_KEY);
      restoreEnv("ANTHROPIC_API_KEY", previous.ANTHROPIC_API_KEY);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
