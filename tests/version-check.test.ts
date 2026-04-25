import { describe, expect, it } from "vitest";
import { checkForUpdate, compareSemver, updateStatusLabel } from "../src/update/version-check.js";

describe("version update checks", () => {
  it("compares normal semantic versions", () => {
    expect(compareSemver("0.1.1", "0.1.2")).toBe(-1);
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });

  it("returns an available status when npm latest is newer", async () => {
    const status = await checkForUpdate({
      packageName: "agentblast-cli",
      currentVersion: "0.1.1",
      fetchImpl: async () =>
        new Response(JSON.stringify({ "dist-tags": { latest: "0.1.2" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    expect(status.state).toBe("available");
    expect(updateStatusLabel(status)).toContain("update 0.1.2 available");
    if (status.state === "available") {
      expect(status.installCommand).toBe("npm install -g agentblast-cli@latest");
    }
  });

  it("fails closed into an unavailable status when registry lookup fails", async () => {
    const status = await checkForUpdate({
      packageName: "agentblast-cli",
      currentVersion: "0.1.1",
      fetchImpl: async () => new Response("nope", { status: 500 })
    });

    expect(status.state).toBe("unavailable");
  });
});
