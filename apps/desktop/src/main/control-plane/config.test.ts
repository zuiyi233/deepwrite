import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadControlPlaneConfig } from "./config";

async function makeUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dw-control-plane-config-"));
}

describe("loadControlPlaneConfig", () => {
  it("defaults to disabled with the default port when no file exists", async () => {
    const dir = await makeUserDataDir();
    const config = loadControlPlaneConfig(dir, {});
    expect(config.enabled).toBe(false);
    expect(config.port).toBe(7630);
    expect(config.token).toBe("");
    expect(config.tokenGenerated).toBe(false);
  });

  it("generates and persists a token when enabled without one", async () => {
    const dir = await makeUserDataDir();
    const config = loadControlPlaneConfig(dir, {
      DEEPWRITE_CONTROL_PLANE: "1"
    });
    expect(config.enabled).toBe(true);
    expect(config.token).toHaveLength(64);
    expect(config.tokenGenerated).toBe(true);
    const persisted = JSON.parse(
      await readFile(config.configPath, "utf-8")
    ) as { token: string; enabled: boolean };
    expect(persisted.token).toBe(config.token);
    expect(persisted.enabled).toBe(true);
  });

  it("env overrides disable the plane", async () => {
    const dir = await makeUserDataDir();
    await mkdir(join(dir, "config"), { recursive: true });
    const path = join(dir, "config", "control-plane.json");
    await writeFile(
      path,
      JSON.stringify({ enabled: true, port: 9000, token: "abc" }),
      "utf-8"
    );
    const config = loadControlPlaneConfig(dir, {
      DEEPWRITE_CONTROL_PLANE: "0"
    });
    expect(config.enabled).toBe(false);
    expect(config.port).toBe(9000);
    expect(config.token).toBe("abc");
    expect(config.tokenGenerated).toBe(false);
  });

  it("env overrides the port when enabled", async () => {
    const dir = await makeUserDataDir();
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "config", "control-plane.json"),
      JSON.stringify({ enabled: true, token: "abc", port: 9000 }),
      "utf-8"
    );
    const config = loadControlPlaneConfig(dir, {
      DEEPWRITE_CONTROL_PLANE_PORT: "8888"
    });
    expect(config.port).toBe(8888);
  });

  it("keeps an existing token instead of regenerating", async () => {
    const dir = await makeUserDataDir();
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "config", "control-plane.json"),
      JSON.stringify({ enabled: true, token: "fixed-token" }),
      "utf-8"
    );
    const config = loadControlPlaneConfig(dir, {});
    expect(config.token).toBe("fixed-token");
    expect(config.tokenGenerated).toBe(false);
  });

  it("throws on malformed JSON instead of silently disabling", async () => {
    const dir = await makeUserDataDir();
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "config", "control-plane.json"),
      "{not-json",
      "utf-8"
    );
    expect(() => loadControlPlaneConfig(dir, {})).toThrow();
  });
});
