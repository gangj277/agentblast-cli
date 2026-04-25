import { createHash } from "node:crypto";
import { AgentSurface, RedTeamCaseClass } from "../core/types.js";

export const BOUNDARY_RE =
  /(untrusted|external content|retrieved content|tool output|terminal output|cannot override|must not override|ignore instructions from|treat .* as data|instruction hierarchy|trusted instructions)/i;
export const SECRET_BOUNDARY_RE = /(do not reveal|never reveal|secret|credential|sensitive|private data|token|api key|canary)/i;
export const TERMINAL_SURFACE_RE = /\b(terminal|shell|command|exec|spawn|execa|child_process|bash|sh)\b|\brunCommand[A-Za-z0-9_]*\b/i;
export const OVER_REFUSAL_RE = /(always refuse|refuse all|never answer|do not answer any|must refuse every|decline all)/i;
export const MEMORY_BOUNDARY_RE = /(do not store|do not persist|memory.*untrusted|persistent.*instruction|user-provided.*memory|cannot override|untrusted)/i;

export function createCaseId(caseClass: RedTeamCaseClass, ...parts: string[]): string {
  const prefix = caseClass
    .split("_")
    .map((part) => part.slice(0, 3).toUpperCase())
    .join("-");
  const hash = createHash("sha256").update([caseClass, ...parts].join("\0")).digest("hex").slice(0, 8).toUpperCase();
  return `RT-${prefix}-${hash}`;
}

export function createAttemptId(caseId: string, strategy: string, ordinal: number, summary: string): string {
  const hash = createHash("sha256").update([caseId, strategy, ordinal, summary].join("\0")).digest("hex").slice(0, 8).toUpperCase();
  return `${caseId}-A${String(ordinal + 1).padStart(2, "0")}-${hash}`;
}

export function truncateEvidence(value: string, limit = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function evidenceFor(surface: AgentSurface, content: string, pattern: RegExp): string {
  if (!content) return surface.evidence || "Source content was not readable during red-team generation.";
  const lines = content.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return surface.evidence || truncateEvidence(lines.slice(0, 4).join(" "));
  return truncateEvidence(
    lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
  );
}

export function hasInstructionBoundary(content: string): boolean {
  return BOUNDARY_RE.test(content);
}

export function hasSecretBoundary(content: string): boolean {
  return SECRET_BOUNDARY_RE.test(content);
}
