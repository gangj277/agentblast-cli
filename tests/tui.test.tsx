import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { AgentBlastView } from "../src/ui/AgentBlastApp.js";

describe("AgentBlastView", () => {
  it("renders the cockpit layout with status, transcript, inspector, and composer", () => {
    const { lastFrame } = render(
      <AgentBlastView
        cwd="/tmp/example"
        model="gpt-5.5"
        oauthStatus="ChatGPT OAuth"
        phase="idle"
        input="/in"
        suggestions={[{ name: "/inspect", description: "Map agent entrypoints, prompts, tools, retrieval" }]}
        events={[{ id: "1", role: "system", text: "Agent Blast ready.", timestamp: new Date().toISOString() }]}
        findings={[]}
        patches={[]}
        width={120}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent Blast");
    expect(frame).toContain("Transcript");
    expect(frame).toContain("Inspector");
    expect(frame).toContain("/inspect");
    expect(frame).toContain("agentblast");
  });

  it("shows confirmation mode for source edits", () => {
    const { lastFrame } = render(
      <AgentBlastView
        cwd="/tmp/example"
        model="gpt-5.5"
        oauthStatus="ChatGPT OAuth"
        phase="confirm"
        input=""
        suggestions={[]}
        events={[{ id: "1", role: "system", text: "Confirm source edit?", timestamp: new Date().toISOString() }]}
        findings={[]}
        patches={[{ id: "PATCH-001", findingId: "AB-001", title: "Patch", targetPath: "a.ts", rationale: "test", diff: "diff", status: "proposed" }]}
        width={120}
        pendingApply
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("confirm");
    expect(frame).toContain("press y/n");
    expect(frame).toContain("PATCH-001");
  });
});
