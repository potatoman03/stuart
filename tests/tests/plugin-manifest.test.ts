import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@stuart/plugin-sdk";

describe("validatePluginManifest", () => {
  it("accepts a minimally valid manifest", () => {
    expect(
      validatePluginManifest({
        id: "local.browser",
        name: "Browser Pack",
        version: "0.1.0",
        description: "Playwright browser tools",
        requiredPermissions: ["browser", "filesystem"]
      }).ok
    ).toBe(true);
  });

  it("rejects unknown permissions", () => {
    const result = validatePluginManifest({
      id: "bad.plugin",
      name: "Bad Plugin",
      version: "0.1.0",
      description: "Bad",
      requiredPermissions: ["telepathy"]
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Unknown permission");
  });
});
