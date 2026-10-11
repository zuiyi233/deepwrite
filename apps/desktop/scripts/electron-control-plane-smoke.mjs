import { assertElectronLaunchAllowed } from "../../../tools/electron-launch-environment.mjs";

assertElectronLaunchAllowed();

import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const workspaceRoot = resolve(appDir, "../..");
const electronDist =
  process.env.ELECTRON_OVERRIDE_DIST_PATH ||
  resolve(workspaceRoot, "node_modules/electron/dist");
const electronBinary =
  process.platform === "darwin"
    ? resolve(electronDist, "Electron.app/Contents/MacOS/Electron")
    : process.platform === "win32"
      ? resolve(electronDist, "electron.exe")
      : resolve(electronDist, "electron");

try {
  await access(resolve(appDir, "out/main/index.js"));
  await access(electronBinary);
} catch {
  console.error(
    "Desktop build or Electron binary is missing. Run `pnpm build` first."
  );
  process.exit(1);
}

const smokeUserData = await realpath(
  await mkdtemp(join(tmpdir(), "deepwrite-control-plane-smoke-"))
);
const controlPlanePort = 37630 + Math.floor(Math.random() * 2000);

const child = spawn(electronBinary, [".", `--user-data-dir=${smokeUserData}`], {
  cwd: appDir,
  env: {
    ...process.env,
    DEEPWRITE_CONTROL_PLANE: "1",
    DEEPWRITE_CONTROL_PLANE_PORT: String(controlPlanePort),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const fail = async (message) => {
  console.error(`DEEPWRITE_SMOKE_FAIL ${message}`);
  console.error(output.slice(-4000));
  child.kill("SIGKILL");
  await cleanup();
  process.exit(1);
};

const cleanup = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(smokeUserData, { recursive: true, force: true });
      return;
    } catch {
      // Windows 文件锁可能短暂残留，稍后重试。
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
    }
  }
};

const timeout = setTimeout(() => fail("timeout"), 90_000);

const tokenFile = join(smokeUserData, "config", "control-plane.json");
const { readFile } = await import("node:fs/promises");

const waitForControlPlane = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const token = JSON.parse(await readFile(tokenFile, "utf-8")).token;
      if (token) {
        const response = await fetch(
          `http://127.0.0.1:${controlPlanePort}/health`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (response.ok) return response.json();
      }
    } catch {
      // 应用尚未完成启动（token 文件或端口未就绪），继续等待。
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
  }
  await fail("control plane did not come up");
  return null;
};

try {
  const health = await waitForControlPlane();
  if (!health?.ok) {
    await fail("health endpoint returned unexpected payload");
  }
  if (!health.appVersion) {
    await fail("health payload missing appVersion");
  }

  const tokenFile = join(smokeUserData, "config", "control-plane.json");
  const { readFile: readFileForToken } = await import("node:fs/promises");
  const { token } = JSON.parse(await readFileForToken(tokenFile, "utf-8"));
  if (!token) await fail("token was not generated");

  const authorizedHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  const postCommand = async (type, payload) => {
    const response = await fetch(
      `http://127.0.0.1:${controlPlanePort}/command`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify({
          protocolVersion: 1,
          id: `smoke-${Date.now()}`,
          type,
          timestamp: new Date().toISOString(),
          context: { correlationId: `smoke-${Date.now()}` },
          payload
        })
      }
    );
    return response.json();
  };

  const listResult = await postCommand("models.list", {});
  if (
    listResult.status !== "accepted" ||
    !Array.isArray(listResult.payload?.models)
  ) {
    await fail(
      `models.list failed: ${JSON.stringify(listResult).slice(0, 300)}`
    );
  }

  const deniedResult = await postCommand("models.refreshFree", {});
  if (
    deniedResult.status !== "rejected" ||
    deniedResult.error?.code !== "control_plane.command_not_allowed"
  ) {
    await fail("allowlist did not reject agent.prompt");
  }

  const unauthorized = await fetch(
    `http://127.0.0.1:${controlPlanePort}/health`
  );
  if (unauthorized.status !== 401) {
    await fail("unauthenticated request was not rejected with 401");
  }

  console.log("DEEPWRITE_SMOKE_OK control-plane");
  clearTimeout(timeout);
  child.kill();
  await new Promise((resolveExit) => setTimeout(resolveExit, 1_500));
  await cleanup();
  process.exit(0);
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timeout);
}
