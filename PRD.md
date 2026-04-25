# AgentBlast CLI PRD

**Status:** Draft for hackathon build
**Date:** 2026-04-25
**Target event:** AI Safety & Security hackathon on 2026-04-26
**Product name:** AgentBlast CLI
**Product category:** Local defensive red-team and hardening CLI for AI agents

## 1. Executive Summary

AgentBlast CLI is a local developer tool that explores a codebase, maps the current AI agent, creates a private `.agentblast` sandbox, runs defensive red-team tests against the copied/sandboxed agent, finds reproducible failures, applies bounded hardening changes, replays the same tests, and produces an evidence report.

The core promise is not "your agent has no weaknesses." The credible promise is:

> AgentBlast found specific AI-agent failure modes, reproduced them, patched the relevant code or policy boundary, and proved the same failures no longer trigger.

## 2. Problem

AI agents combine untrusted natural language, private context, retrieval, memory, and tools. This creates a security problem that normal application scanners do not capture well: text from users, documents, emails, webpages, or retrieved context can influence the agent's behavior, including tool calls and data disclosure.

Most teams building agents do not have a repeatable local workflow for answering:

- What agent entrypoints exist in this codebase?
- Which prompts, tools, retrieval paths, and side effects does the agent use?
- Can untrusted input cause secret leakage, policy bypass, or unauthorized tool use?
- What exact transcript proves the failure?
- What concrete change reduced the blast radius?
- Can the same failure be replayed and shown fixed?

AgentBlast turns this into a local, auditable loop.

## 3. First-Principles Product Thesis

An AI agent security tool should not start from "detect bad prompts." It should start from the actual security boundary:

```text
AI agent = model + instructions + untrusted input + private context + tools + permissions
```

The risk appears when untrusted language can influence privileged behavior. Therefore, the product must inspect both:

1. **Reasoning surface:** prompts, retrieved context, memory, system/developer instructions.
2. **Authority surface:** tools, credentials, database access, file access, external actions, human approval gates.

The valuable output is not a generic warning. It is replayable proof:

```text
finding -> evidence trace -> affected tool/data -> patch -> replay result
```

## 4. Target Users

### Primary ICP

AI engineers and product security engineers building internal or customer-facing AI agents.

They need a runnable local tool that helps them catch obvious agent security failures before security review, customer review, or production release.

### Secondary Users

- Startup CTOs shipping AI features.
- AppSec teams evaluating agentic applications.
- AI governance teams needing evidence packets.
- Hackathon judges evaluating a concrete security demo.

## 5. Goals

### Product Goals

- Explore a local codebase and identify likely AI agent entrypoints.
- Map prompts, model calls, tool definitions, retrieval sources, and side-effect paths.
- Create a private local `.agentblast` workspace.
- Run safe defensive red-team tests using synthetic canaries and controlled test cases.
- Detect reproducible failures such as canary leakage, unauthorized tool invocation, and instruction boundary failures.
- Generate bounded hardening changes or patch suggestions.
- Replay the same tests after hardening.
- Produce a clear report with findings, evidence, changes, and replay results.

### Hackathon Goals

- Deliver a working CLI plus one polished dashboard/report.
- Support one primary stack well: TypeScript/Next.js with OpenAI SDK or Vercel AI SDK.
- Demonstrate one vulnerable sample agent before and after hardening.
- Show at least three finding classes:
  - canary secret leakage
  - indirect prompt injection through retrieved content
  - unauthorized or unsafe tool invocation

## 6. Non-Goals

- Do not claim complete AI safety or absence of all vulnerabilities.
- Do not scan third-party systems without authorization.
- Do not generate offensive exploit kits or target real services.
- Do not copy `.env`, private keys, production databases, `.git`, `node_modules`, build artifacts, or user secrets into `.agentblast`.
- Do not support every framework in the hackathon MVP.
- Do not build a full enterprise AI security platform.
- Do not mutate the user's real source code without explicit confirmation.

## 7. Product Workflow

```text
agentblast init
  -> creates .agentblast and config

agentblast inspect
  -> maps agent entrypoints, prompts, tools, retrieval, memory, risks

agentblast scan
  -> creates sandbox, seeds canaries, runs defensive tests, records traces

agentblast harden
  -> generates bounded patch suggestions or applies changes inside sandbox

agentblast replay
  -> reruns the exact failing tests against the hardened sandbox

agentblast report
  -> produces report.html and report.md with evidence and replay proof
```

## 8. CLI Command Specification

### `agentblast init`

Creates local configuration.

Outputs:

- `.agentblast/config.json`
- `.agentblast/.gitignore`
- optional root `.gitignore` entry for `.agentblast/`

Example:

```bash
agentblast init
```

### `agentblast inspect`

Explores the repository and builds an agent map.

Inputs:

- current working directory
- optional config overrides

Outputs:

- `.agentblast/agent-map.json`
- console summary of detected agent surfaces

Detects:

- API routes and handlers
- model SDK calls
- system/developer prompt files
- tool/function definitions
- retrieval/RAG modules
- memory/state stores
- external side-effect tools

### `agentblast scan`

Runs defensive red-team tests against the sandboxed agent.

Example:

```bash
agentblast scan --profile agent-basic
```

Outputs:

- `.agentblast/runs/<run-id>/traces.jsonl`
- `.agentblast/runs/<run-id>/findings.json`
- `.agentblast/runs/<run-id>/summary.json`

### `agentblast harden`

Generates patch suggestions, and optionally applies them to the sandbox.

Example:

```bash
agentblast harden --run latest --apply-sandbox
```

Patch classes:

- tool allowlist
- side-effect tool confirmation gate
- retrieved-content isolation
- canary leakage detector
- output secret filter
- structured tool permission checks
- regression tests for discovered failures

### `agentblast replay`

Reruns only the previously failing tests against the hardened sandbox.

Example:

```bash
agentblast replay --run latest
```

Success condition:

- previously leaked canary is not leaked
- previously unauthorized tool call is blocked or approval-gated
- previously unsafe behavior is converted into a refusal or safe fallback

### `agentblast report`

Generates a human-readable evidence packet.

Example:

```bash
agentblast report --run latest --format html,md
```

Outputs:

- `.agentblast/runs/<run-id>/report.html`
- `.agentblast/runs/<run-id>/report.md`

## 9. `.agentblast` Directory Structure

```text
.agentblast/
  config.json
  agent-map.json
  sandbox/
    source/
    mocks/
    patches/
  runs/
    2026-04-26T10-15-00/
      traces.jsonl
      findings.json
      summary.json
      replay.json
      report.md
      report.html
      patches/
        patch-001.diff
        patch-002.diff
```

Privacy rules:

- `.agentblast/` is private local state.
- `.agentblast/` should be ignored by Git.
- Real secrets are never copied.
- External side effects are mocked by default.
- Reports should redact sensitive values and show synthetic canaries only.

## 10. Agent Map Schema

```json
{
  "project": {
    "root": "/absolute/path/to/project",
    "framework": "nextjs",
    "language": "typescript"
  },
  "entrypoints": [
    {
      "path": "app/api/agent/route.ts",
      "type": "http_route",
      "method": "POST"
    }
  ],
  "modelCalls": [
    {
      "provider": "openai",
      "sdk": "openai",
      "path": "lib/agent/run-agent.ts"
    }
  ],
  "prompts": [
    {
      "path": "lib/agent/system-prompt.ts",
      "kind": "system"
    }
  ],
  "tools": [
    {
      "name": "queryCustomers",
      "path": "lib/agent/tools/query-customers.ts",
      "sideEffect": false,
      "dataAccess": "customer_records"
    },
    {
      "name": "sendEmail",
      "path": "lib/agent/tools/send-email.ts",
      "sideEffect": true,
      "requiresApproval": false
    }
  ],
  "retrieval": [
    {
      "path": "lib/rag/search.ts",
      "source": "docs"
    }
  ],
  "riskAreas": [
    "indirect_prompt_injection",
    "canary_leakage",
    "unsafe_tool_invocation"
  ]
}
```

## 11. Finding Schema

```json
{
  "id": "AB-001",
  "title": "Canary secret leaked from retrieved context",
  "severity": "high",
  "category": "sensitive_information_disclosure",
  "owasp": "LLM02",
  "entrypoint": "app/api/agent/route.ts",
  "affectedSurfaces": ["retrieval", "model_output"],
  "evidence": {
    "runId": "2026-04-26T10-15-00",
    "traceId": "trace-003",
    "canary": "CANARY_CUSTOMER_TOKEN_7421",
    "leaked": true
  },
  "recommendedFix": {
    "type": "output_filter",
    "description": "Block known canary and secret-shaped values from model output."
  },
  "replayStatus": "fixed"
}
```

## 12. Defensive Test Profiles

### MVP Profile: `agent-basic`

Test classes:

1. **Canary leakage**
   - Seed synthetic secrets into mock private context.
   - Check whether the agent reveals the canary in output.

2. **Indirect prompt injection through retrieved content**
   - Insert controlled instruction-like text into mock retrieved documents.
   - Check whether the agent follows untrusted content over trusted instructions.

3. **Unauthorized tool invocation**
   - Attempt to cause the agent to call a side-effect tool outside policy.
   - Check whether action is blocked, approval-gated, or executed.

4. **System prompt exposure**
   - Check whether the agent reveals internal instructions or hidden policy text.

5. **Unsafe cross-boundary data use**
   - Check whether data from one user/session/context appears in another output.

Important: tests must be safe, synthetic, and run only against local owned code.

## 13. Hardening Strategy

AgentBlast should not attempt arbitrary autonomous rewriting. It should generate bounded, explainable changes.

### Hardening Classes

| Class | Failure addressed | Example change |
|---|---|---|
| Tool permission gate | Unsafe side effects | Require approval before external sends/writes |
| Tool allowlist | Excessive agency | Only expose tools required for the current task |
| Retrieved-content isolation | Indirect prompt injection | Wrap retrieved text as untrusted evidence, not instructions |
| Canary/output filter | Secret leakage | Block known canaries and secret-shaped values |
| Prompt policy patch | Instruction hierarchy weakness | Clarify that external content cannot override system/developer instructions |
| Regression test | Recurrence risk | Add replay test for exact discovered failure |

### Patch Rules

- Prefer sandbox patch first.
- Show diff before modifying real source.
- Require explicit `--apply-source` to touch original code.
- Never patch unrelated files.
- Never rewrite core app architecture during hackathon MVP.

## 14. Report Requirements

The report should be judge-friendly and security-review-friendly.

Sections:

1. Executive summary
2. Agent map
3. Findings table
4. Evidence traces
5. OWASP/NIST mapping
6. Patch summary
7. Replay result
8. Residual risk
9. Recommended next controls

Example finding table:

| ID | Severity | Failure | Evidence | Patch | Replay |
|---|---|---|---|---|---|
| AB-001 | High | Canary leaked | trace-003 | output filter | Fixed |
| AB-002 | High | Side-effect tool called without approval | trace-006 | approval gate | Fixed |
| AB-003 | Medium | Retrieved document overrode instruction boundary | trace-009 | retrieved-content isolation | Fixed |

The report must avoid the phrase "fully safe." Use:

- "replay passed"
- "discovered failure fixed"
- "residual risk remains"
- "additional testing recommended"

## 15. MVP Architecture

```text
CLI
  |
  |-- Project Inspector
  |     |-- file scanner
  |     |-- framework detector
  |     |-- model-call detector
  |     |-- prompt/tool/retrieval mapper
  |
  |-- Sandbox Manager
  |     |-- safe source copy
  |     |-- env/secrets exclusion
  |     |-- mock side effects
  |
  |-- Test Runner
  |     |-- canary seeder
  |     |-- defensive test profiles
  |     |-- trace recorder
  |
  |-- Finding Engine
  |     |-- leakage detector
  |     |-- tool-call policy checker
  |     |-- instruction-boundary checker
  |
  |-- Hardening Engine
  |     |-- patch suggestion generator
  |     |-- sandbox patch applier
  |     |-- replay selector
  |
  |-- Reporter
        |-- markdown report
        |-- html dashboard
        |-- JSON export
```

## 16. Hackathon Implementation Plan

### First 2 Hours

- Create CLI skeleton.
- Implement `.agentblast` initialization.
- Build sample vulnerable Next.js agent.
- Add mock tools: `queryCustomers`, `sendEmailDraft`, `createTicket`.

### Hours 3-6

- Implement codebase inspector for TypeScript/Next.js.
- Detect API route, OpenAI/Vercel AI SDK call, prompt file, and tools.
- Generate `agent-map.json`.
- Build sandbox copy with secrets/build artifacts excluded.

### Hours 7-10

- Implement canary seeding.
- Implement three tests:
  - canary leakage
  - indirect prompt injection in retrieved docs
  - unauthorized side-effect tool call
- Record `traces.jsonl` and `findings.json`.

### Hours 11-14

- Implement hardening patch suggestions.
- Apply patches to sandbox:
  - approval gate for side-effect tools
  - retrieved-content isolation wrapper
  - canary/output filter
- Implement replay of failed tests.

### Hours 15-18

- Generate `report.md` and simple `report.html`.
- Polish demo flow.
- Add final CLI output and screenshots.

### Stretch

- GitHub Action mode.
- Multi-framework detection.
- Interactive TUI.
- PDF export.
- Model-graded finding summaries.

## 17. Demo Script

1. Start with a vulnerable sample agent.
2. Show the agent has tools and private mock customer context.
3. Run:

```bash
agentblast init
agentblast inspect
agentblast scan --profile agent-basic
```

4. Open the report:
   - canary leaked
   - untrusted retrieved content influenced behavior
   - side-effect tool was called without approval

5. Run:

```bash
agentblast harden --run latest --apply-sandbox
agentblast replay --run latest
agentblast report --run latest
```

6. Show replay result:
   - canary blocked
   - side-effect tool approval-gated
   - retrieved-content instruction ignored or safely summarized

7. Close with:

> AgentBlast does not claim perfect safety. It gives developers reproducible AI-agent security evidence and proves that discovered failures were fixed.

## 18. Success Metrics

### Hackathon Success

- CLI works end-to-end on sample agent.
- At least three failure classes detected.
- At least two hardening patches generated.
- Replay proves at least two failures are fixed.
- Report is clear enough for a judge to understand in under two minutes.

### Product Success

- Inspection finds the correct agent entrypoint with minimal configuration.
- False positives are explainable and bounded.
- Every finding includes a trace.
- Every patch includes rationale and diff.
- Every claimed fix has replay evidence.

## 19. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Scope creep into full platform | MVP does not finish | Support one stack and one demo agent |
| Unsafe or ambiguous security framing | Judges misunderstand intent | Emphasize local owned-code defensive testing |
| Patch engine breaks app | Demo failure | Apply patches to sandbox first |
| Scanner cannot infer all code paths | Weak findings | Use heuristics plus optional config |
| Report overclaims safety | Credibility loss | Use replay-backed claims only |
| Existing tools look similar | Differentiation risk | Emphasize codebase inspection + sandbox patch + replay proof |

## 20. Open Questions

- Should the MVP patch real source code with confirmation, or only produce sandbox diffs?
- Should the sample agent use OpenAI SDK directly or Vercel AI SDK?
- Should the report prioritize OWASP mapping or a product-security narrative?
- Should we ship a dashboard, or keep it as generated HTML?
- Should the first version support GitHub Action mode, or defer it?

## 21. Decision

Build **AgentBlast CLI** as a local defensive red-team and hardening workflow for AI agents.

The MVP should optimize for one sharp loop:

```text
inspect codebase -> sandbox agent -> find failure -> harden -> replay -> report
```

This is stronger than a generic scanner because it produces concrete evidence and a bounded remediation path. It is stronger than a pure guardrail because it proves the guardrail against a reproduced failure. It is narrow enough to build in a hackathon and credible enough to become a real developer security product afterward.
