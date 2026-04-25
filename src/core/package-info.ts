import { readFileSync } from "node:fs";

type PackageJson = {
  name: string;
  version: string;
};

const packageJson = readPackageJson();

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;

function readPackageJson(): PackageJson {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AgentBlast package metadata is invalid.");
  }

  const candidate = parsed as Partial<PackageJson>;
  if (!candidate.name || !candidate.version) {
    throw new Error("AgentBlast package metadata is missing name or version.");
  }

  return {
    name: candidate.name,
    version: candidate.version
  };
}
