import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { AgentBlastView, parseInteractiveCommand, parseRedTeamOptions } from "../src/ui/AgentBlastApp.js";

describe("AgentBlastView", () => {
  it("renders the cockpit layout with status, transcript, inspector, and composer", () => {
    const { lastFrame } = render(
      <AgentBlastView
        cwd="/tmp/example"
        model="gpt-5.5"
        oauthStatus="ChatGPT OAuth"
        phase="idle"
        input="/in"
        suggestions={[{ name: "/inspect", usage: "/inspect", description: "Map agent entrypoints, prompts, tools, retrieval" }]}
        events={[{ id: "1", role: "system", text: "Agent Blast ready.", timestamp: new Date().toISOString() }]}
        findings={[]}
        patches={[]}
        updateStatus={{ state: "current", packageName: "agentblast-cli", currentVersion: "0.1.1", latestVersion: "0.1.1", checkedAt: new Date().toISOString() }}
        width={120}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent Blast");
    expect(frame).toContain("Transcript");
    expect(frame).toContain("Inspector");
    expect(frame).toContain("Workflow");
    expect(frame).toContain("Next: /inspect");
    expect(frame).toContain("/inspect");
    expect(frame).toContain("agentblast >");
    expect(frame).toContain("Tab complete");
    expect(frame).toContain("v0.1.1 current");
  });

  it("shows a visible update indicator when a newer CLI release exists", () => {
    const { lastFrame } = render(
      <AgentBlastView
        cwd="/tmp/example"
        model="gpt-5.5"
        oauthStatus="ChatGPT OAuth"
        phase="idle"
        input=""
        suggestions={[]}
        events={[{ id: "1", role: "system", text: "Agent Blast ready.", timestamp: new Date().toISOString() }]}
        findings={[]}
        patches={[]}
        updateStatus={{
          state: "available",
          packageName: "agentblast-cli",
          currentVersion: "0.1.1",
          latestVersion: "0.1.2",
          installCommand: "npm install -g agentblast-cli@latest",
          checkedAt: new Date().toISOString()
        }}
        width={120}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("update 0.1.2 available");
    expect(frame).toContain("Run /update");
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
        updateStatus={{ state: "current", packageName: "agentblast-cli", currentVersion: "0.1.1", latestVersion: "0.1.1", checkedAt: new Date().toISOString() }}
        width={120}
        pendingApply
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("confirm");
    expect(frame).toContain("press y to apply");
    expect(frame).toContain("PATCH-001");
  });

  it("parses interactive red-team command options like the non-interactive CLI", () => {
    expect(parseInteractiveCommand("/redteam standard --strategy fuzz --max-attempts-per-case 5")).toEqual({
      name: "/redteam",
      args: ["standard", "--strategy", "fuzz", "--max-attempts-per-case", "5"]
    });

    expect(parseRedTeamOptions(["deep", "--strategy", "hybrid", "--max-depth", "4", "--include-terminal-checks"])).toEqual({
      mode: "deep",
      strategy: "hybrid",
      maxDepth: 4,
      includeTerminalChecks: true
    });
  });
});
