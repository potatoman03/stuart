import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDatabase } from "@stuart/db";

describe("LocalDatabase native provider credentials", () => {
  const dir = join(process.cwd(), ".stuart-test-native-creds");
  const dbPath = join(dir, "test.sqlite");

  it("stores and merges Gemini and MiniMax secrets", () => {
    mkdirSync(dir, { recursive: true });
    try {
      const db = new LocalDatabase(dbPath);
      expect(db.getNativeProviderCredentialsPublic()).toEqual({
        geminiConfigured: false,
        minimaxConfigured: false,
      });

      db.updateNativeProviderCredentials({ geminiApiKey: "g-secret" });
      expect(db.getNativeProviderCredentialsPublic()).toEqual({
        geminiConfigured: true,
        minimaxConfigured: false,
      });

      db.updateNativeProviderCredentials({ minimaxApiKey: "m-key" });
      expect(db.getNativeProviderSecrets()).toMatchObject({
        geminiApiKey: "g-secret",
        minimaxApiKey: "m-key",
        minimaxAccessToken: null,
      });

      db.updateNativeProviderCredentials({ geminiApiKey: null });
      expect(db.getNativeProviderSecrets().geminiApiKey).toBeNull();
      expect(db.getNativeProviderSecrets().minimaxApiKey).toBe("m-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
