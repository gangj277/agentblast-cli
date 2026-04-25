import { AgentMap, AgentSurface, ToolSurface } from "../core/types.js";
import { safeReadFileDetailed, searchCode } from "../tools/repo-tools.js";
import { TERMINAL_SURFACE_RE } from "./signals.js";

export type SurfaceContent = {
  surface: AgentSurface;
  content: string;
};

export type RedTeamSurfaceProfile = {
  cwd: string;
  agentMap: AgentMap;
  promptSurfaces: SurfaceContent[];
  modelCallSurfaces: SurfaceContent[];
  retrievalSurfaces: SurfaceContent[];
  toolSurfaces: Array<{ surface: ToolSurface; content: string }>;
  memorySurfaces: SurfaceContent[];
  terminalToolSurfaces: Array<{ surface: ToolSurface; content: string }>;
};

export async function profileRedTeamSurfaces(cwd: string, agentMap: AgentMap): Promise<RedTeamSurfaceProfile> {
  const reader = createSurfaceReader(cwd);
  const promptSurfaces = await readSurfaces(promptSurfacesForRedTeam(agentMap), reader);
  const modelCallSurfaces = await readSurfaces(agentMap.modelCalls, reader);
  const retrievalSurfaces = await readSurfaces(agentMap.retrieval, reader);
  const memorySurfaces = await readSurfaces(await detectMemorySurfaces(cwd), reader);
  const toolSurfaces = await Promise.all(agentMap.tools.map(async (surface) => ({ surface, content: await reader(surface.path) })));
  const terminalToolSurfaces = toolSurfaces.filter(({ surface }) => TERMINAL_SURFACE_RE.test(`${surface.name} ${surface.path} ${surface.evidence}`));

  return {
    cwd,
    agentMap,
    promptSurfaces,
    modelCallSurfaces,
    retrievalSurfaces,
    toolSurfaces,
    memorySurfaces,
    terminalToolSurfaces
  };
}

function promptSurfacesForRedTeam(agentMap: AgentMap): AgentSurface[] {
  const dedicatedPromptSurfaces = agentMap.prompts.filter((surface) =>
    /(^|\/)(prompts?|system-prompt|developer-prompt|agent\/prompt)\b|prompt\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(surface.path)
  );
  return dedicatedPromptSurfaces.length > 0 ? dedicatedPromptSurfaces : agentMap.prompts;
}

async function detectMemorySurfaces(cwd: string): Promise<AgentSurface[]> {
  const matches = await searchCode(cwd, "memory|conversation|session|persist|store", { limit: 30 });
  const seen = new Set<string>();
  return matches
    .filter((match) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(match.path))
    .filter((match) => !/(^|\/)(tests?|__tests__|fixtures?|mocks?)\//i.test(match.path))
    .filter((match) => {
      if (seen.has(match.path)) return false;
      seen.add(match.path);
      return true;
    })
    .slice(0, 4)
    .map((match) => ({
      path: match.path,
      kind: "memory_state",
      evidence: match.text
    }));
}

async function readSurfaces(surfaces: AgentSurface[], reader: (relativePath: string) => Promise<string>): Promise<SurfaceContent[]> {
  return Promise.all(surfaces.map(async (surface) => ({ surface, content: await reader(surface.path) })));
}

function createSurfaceReader(cwd: string): (relativePath: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (relativePath: string) => {
    const cached = cache.get(relativePath);
    if (cached !== undefined) return cached;
    try {
      const file = await safeReadFileDetailed(cwd, relativePath, { limit: 2_000, maxBytes: 140_000 });
      cache.set(relativePath, file.content);
      return file.content;
    } catch {
      cache.set(relativePath, "");
      return "";
    }
  };
}
