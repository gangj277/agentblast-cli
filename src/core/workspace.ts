import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentBlastConfig, AgentBlastRun, AgentMap, Finding, PatchProposal, RedTeamRun, ReplayResult } from "./types.js";
import { runPath, workspacePath } from "./paths.js";

export class AgentBlastWorkspace {
  readonly cwd: string;
  readonly model: string;

  constructor(input: { cwd: string; model: string }) {
    this.cwd = input.cwd;
    this.model = input.model;
  }

  async init(): Promise<AgentBlastConfig> {
    const root = workspacePath(this.cwd);
    await mkdir(path.join(root, "runs"), { recursive: true });
    await mkdir(path.join(root, "reports"), { recursive: true });
    await mkdir(path.join(root, "backups"), { recursive: true });

    const config: AgentBlastConfig = {
      version: 1,
      cwd: this.cwd,
      model: this.model,
      createdAt: new Date().toISOString()
    };

    await this.writeJson("config.json", config);
    await this.writePrivateGitignore();
    return config;
  }

  async writeAgentMap(agentMap: AgentMap): Promise<void> {
    await this.ensureReady();
    await this.writeJson("agent-map.json", agentMap);
  }

  async readAgentMap(): Promise<AgentMap | undefined> {
    return this.readJson<AgentMap>("agent-map.json");
  }

  async createRun(input: {
    agentMap?: AgentMap;
    findings?: Finding[];
    patches?: PatchProposal[];
  }): Promise<AgentBlastRun> {
    await this.ensureReady();
    const run: AgentBlastRun = {
      id: createRunId(),
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
      agentMap: input.agentMap,
      findings: input.findings ?? [],
      patches: input.patches ?? []
    };
    await this.writeRun(run);
    return run;
  }

  async writeRun(run: AgentBlastRun): Promise<void> {
    await mkdir(runPath(this.cwd, run.id), { recursive: true });
    await writeJsonFile(path.join(runPath(this.cwd, run.id), "run.json"), run);
    await writeJsonFile(path.join(runPath(this.cwd, run.id), "findings.json"), run.findings);
    await writeJsonFile(path.join(runPath(this.cwd, run.id), "patches.json"), run.patches);
    if (run.redTeam) {
      await writeJsonFile(path.join(runPath(this.cwd, run.id), "red-team.json"), run.redTeam);
    }
    if (run.replay) {
      await writeJsonFile(path.join(runPath(this.cwd, run.id), "replay.json"), run.replay);
    }
  }

  async readRun(runId: string): Promise<AgentBlastRun | undefined> {
    return readJsonFile<AgentBlastRun>(path.join(runPath(this.cwd, runId), "run.json"));
  }

  async writePatchFile(runId: string, patch: PatchProposal): Promise<string> {
    const patchesDir = path.join(runPath(this.cwd, runId), "patches");
    await mkdir(patchesDir, { recursive: true });
    const filePath = path.join(patchesDir, `${patch.id}.diff`);
    await writeFile(filePath, patch.diff, "utf8");
    return filePath;
  }

  async writeReport(runId: string, markdown: string, html: string): Promise<{ runReportPath: string; latestReportPath: string; htmlReportPath: string }> {
    const runReportPath = path.join(runPath(this.cwd, runId), "report.md");
    const htmlReportPath = path.join(runPath(this.cwd, runId), "report.html");
    const latestReportPath = path.join(workspacePath(this.cwd), "reports", "latest.md");
    const latestHtmlPath = path.join(workspacePath(this.cwd), "reports", "latest.html");
    await writeFile(runReportPath, markdown, "utf8");
    await writeFile(htmlReportPath, html, "utf8");
    await writeFile(latestReportPath, markdown, "utf8");
    await writeFile(latestHtmlPath, html, "utf8");
    return { runReportPath, latestReportPath, htmlReportPath };
  }

  async writeReplay(run: AgentBlastRun, replay: ReplayResult): Promise<AgentBlastRun> {
    const nextRun = { ...run, replay };
    await this.writeRun(nextRun);
    return nextRun;
  }

  async writeRedTeamRun(run: AgentBlastRun, redTeam: RedTeamRun): Promise<AgentBlastRun> {
    const nextRun = { ...run, redTeam };
    await this.writeRun(nextRun);
    return nextRun;
  }

  private async ensureReady(): Promise<void> {
    await mkdir(workspacePath(this.cwd), { recursive: true });
    await mkdir(path.join(workspacePath(this.cwd), "runs"), { recursive: true });
    await mkdir(path.join(workspacePath(this.cwd), "reports"), { recursive: true });
    await mkdir(path.join(workspacePath(this.cwd), "backups"), { recursive: true });
  }

  private async writePrivateGitignore(): Promise<void> {
    await writeFile(path.join(workspacePath(this.cwd), ".gitignore"), "*\n!.gitignore\n", "utf8");
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    await writeJsonFile(path.join(workspacePath(this.cwd), relativePath), value);
  }

  private async readJson<T>(relativePath: string): Promise<T | undefined> {
    return readJsonFile<T>(path.join(workspacePath(this.cwd), relativePath));
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
