# AgentBlast CLI

Local defensive red-team and hardening CLI for AI agents.

## Install

Install from npm:

```bash
npm install -g agentblast-cli
```

Run Agent Blast in any local codebase:

```bash
cd /path/to/your/agent-app
agentblast
```

Run a non-interactive red-team scan:

```bash
agentblast redteam --mode quick --json
agentblast redteam --mode standard --strategy fuzz --max-attempts-per-case 5 --json
agentblast redteam --mode deep --strategy hybrid --max-depth 4 --json
```

## Requirements

- Node.js 20 or newer.
- A local Codex ChatGPT/OAuth login for live model-backed agent turns.
- A target codebase you own or are authorized to test.

Check OAuth status after install:

```bash
agentblast codex status
```

## What Agent Blast Does

Agent Blast maps AI-agent surfaces in a local codebase, runs bounded local red-team checks, proposes hardening patches, replays the suite, and writes evidence reports.

It focuses on:

- prompt and instruction-boundary failures
- indirect prompt injection through retrieved/tool content
- side-effect tool misuse
- synthetic canary disclosure
- memory/session persistence poisoning
- terminal/tool-output contamination
- over-refusal and utility/security tradeoffs

Agent Blast is defensive tooling for local or owned systems. It does not claim a system is fully safe; it reports what was checked, what failed, what changed, and what replay evidence exists.

## Local Development

Clone the repository:

```bash
git clone https://github.com/GANGJ277/agentblast-cli.git
cd agentblast-cli
```

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
npm run test:agent-tools
npm run test:frontier-redteam
```

## Current Infrastructure

This project uses the user's existing Codex ChatGPT/OAuth login instead of `OPENAI_API_KEY`. The interactive agent path calls the Codex Responses endpoint directly and passes native function tools, then executes local tool calls inside AgentBlast.

Default model:

```text
gpt-5.5
```

Auth rule:

```text
Codex login status must be: Logged in using ChatGPT
```

The legacy `codex exec` wrapper is kept for diagnostics, but the AgentBlast runtime does not depend on shelling out for agent turns. It reads `~/.codex/auth.json`, sends OAuth bearer headers to `https://chatgpt.com/backend-api/codex/responses`, parses streamed `function_call` events, and continues with `function_call_output` messages.

## Validation Commands

Run local unit tests:

```bash
npm test
```

Run the deterministic Agent Blast tool-loop smoke test:

```bash
npm run test:agent-tools
```

This smoke verifies native agent tool dispatch for code search, file read, guarded terminal execution, and the bounded `red_team_agent` harness.

Run the frontier-style self-test benchmark:

```bash
npm run test:frontier-redteam
```

This creates a deliberately vulnerable local AI-agent fixture, runs `red_team_agent`, checks root-cause evidence quality, generates hardening patches, applies them, replays the suite, and fails if red-team/static findings do not improve. Use `tsx scripts/frontier-redteam-self-test.ts --mode deep` for a larger deterministic suite, or add `--live-agent` to also verify that the live Codex OAuth AgentBlast loop chooses the `red_team_agent` native tool.

Run the slower deep attack-search benchmark:

```bash
npm run test:frontier-redteam:deep
```

Check Codex OAuth status:

```bash
node dist/cli.js codex status
```

Launch the full-screen Agent Blast TUI:

```bash
node dist/cli.js
```

Useful TUI commands:

```text
/inspect  map agent entrypoints, prompts, tools, and retrieval
/scan     generate defensive findings
/redteam  run bounded local adversarial cases
/harden   prepare patch proposals
/apply    preview and confirm the next source patch
/replay   rerun checks after patching
/report   write Markdown and HTML reports
```

Run the red-team harness non-interactively:

```bash
node dist/cli.js redteam --mode quick --json
node dist/cli.js redteam --mode standard --strategy fuzz --max-attempts-per-case 5 --json
node dist/cli.js redteam --mode deep --strategy hybrid --max-depth 4 --json
```

Run live Codex OAuth smoke test with `gpt-5.5`:

```bash
npm run test:codex
```

Run the built CLI smoke test:

```bash
node dist/cli.js codex smoke --model gpt-5.5
```

Expected smoke output:

```json
{
  "ok": true,
  "model": "gpt-5.5",
  "auth": "codex-oauth",
  "nativeTools": true
}
```

## Environment Overrides

```bash
AGENTBLAST_CODEX_BIN=/path/to/codex
AGENTBLAST_CODEX_MODEL=gpt-5.5
```

## Implementation Notes

- Native Codex Responses/OAuth integration lives in `src/codex/codex-responses-client.ts`.
- The legacy Codex CLI diagnostic wrapper lives in `src/codex/codex-oauth-client.ts`.
- The public CLI entrypoint is `src/cli.tsx`.
- The TUI lives in `src/ui/AgentBlastApp.tsx`.
- The native model-callable agent tool loop lives in `src/agent`.
- Deterministic repo inspection lives in `src/tools`, `src/inspect`, and `src/scan`.
- The red-team harness is a five-stage local pipeline under `src/redteam`: `surface-profiler`, `scenario-planner`, `attack-search`, `local-executor`, `judge`, and `reducer`.
- `red_team_agent` now produces active replayable attempts with attack strategy, observed trace, judge verdict, score, best attempt, root cause, patch-validation status, and attack-success-rate metrics.
- Attack dimensions include instruction-boundary failures, indirect prompt injection, retrieval poisoning, tool misuse, synthetic canary disclosure, memory persistence, terminal/tool-output contamination, over-refusal, and utility/security tradeoff checks.
- Quick mode runs deterministic attempts. Standard mode adds bounded fuzz mutations. Deep mode adds hybrid tree-search attempts with pruning and depth limits.
- The frontier self-test benchmark lives in `scripts/frontier-redteam-self-test.ts`.
- Guarded terminal execution lives in `src/tools/terminal-tools.ts`; it allows local diagnostics, tests, `npm run ...`, Node/Python scripts, and inline Node/Python diagnostics. It blocks destructive, network/remote-shell, credential-reading, package-install/publish, and git history/state mutation commands.
- Red-team results are written under `.agentblast/runs/<run-id>/red-team.json`.
- Reports are written under `.agentblast/runs/<run-id>/report.md` and `report.html`.
- The live integration smoke test is `scripts/codex-oauth-smoke.ts`; it verifies a real native function call through Codex OAuth.
- Unit tests live in `tests/codex-oauth-client.test.ts` and `tests/codex-responses-client.test.ts`.

## Current V1 Loop

```text
inspect codebase -> scan -> redteam -> propose patches -> confirm/apply -> replay -> report
```

Source edits require confirmation in the TUI. Agent Blast does not claim full safety; it reports discovered findings and replay-backed changes.
