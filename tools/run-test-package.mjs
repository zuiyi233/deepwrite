import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";
import { assertElectronLaunchAllowed } from "./electron-launch-environment.mjs";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(toolsDirectory, "..");
const appDirectory = resolve(workspaceRoot, "apps/desktop");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd = workspaceRoot) {
  console.log(`PACKAGE_STEP command=${command} ${args.join(" ")}`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      // Node >= 18.20 refuses to spawn .cmd/.bat without a shell (EINVAL).
      shell: process.platform === "win32" && command.endsWith(".cmd")
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} 执行失败（exit=${String(code)}, signal=${String(signal)}）`
        )
      );
    });
  });
}

export function parseTarget(args) {
  const [platform, arch] = args;
  if ((platform === "all" || platform === "desktop") && arch === undefined) {
    return {
      buildLinuxX64: platform === "all",
      buildMacArm64: true,
      buildMacX64: true,
      buildWinX64: true
    };
  }
  if (platform === "mac" && arch === "all") {
    return {
      buildLinuxX64: false,
      buildMacArm64: true,
      buildMacX64: true,
      buildWinX64: false
    };
  }
  if (platform === "mac" && arch === "arm64") {
    return {
      buildLinuxX64: false,
      buildMacArm64: true,
      buildMacX64: false,
      buildWinX64: false
    };
  }
  if (platform === "mac" && arch === "x64") {
    return {
      buildLinuxX64: false,
      buildMacArm64: false,
      buildMacX64: true,
      buildWinX64: false
    };
  }
  if (platform === "win" && arch === "x64") {
    return {
      buildLinuxX64: false,
      buildMacArm64: false,
      buildMacX64: false,
      buildWinX64: true
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      buildLinuxX64: true,
      buildMacArm64: false,
      buildMacX64: false,
      buildWinX64: false
    };
  }
  throw new Error(
    "Usage: node tools/run-test-package.mjs <all | desktop | linux x64 | mac arm64 | mac x64 | mac all | win x64>"
  );
}

async function electronVersion() {
  const packageJson = JSON.parse(
    await readFile(
      resolve(workspaceRoot, "node_modules/electron/package.json"),
      "utf8"
    )
  );
  return packageJson.version;
}

async function buildMac(target, version) {
  const architectures = [
    ...(target.buildMacArm64 ? ["--arm64"] : []),
    ...(target.buildMacX64 ? ["--x64"] : [])
  ];
  if (!architectures.length) return;
  await run(
    pnpmCommand,
    [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.yml",
      `--config.electronVersion=${version}`,
      "--mac",
      "dmg",
      "zip",
      ...architectures,
      "--publish",
      "never"
    ],
    appDirectory
  );
  if (target.buildMacArm64) {
    await run(
      pnpmCommand,
      ["exec", "node", "scripts/verify-test-package.mjs", "mac", "arm64"],
      appDirectory
    );
  }
  if (target.buildMacX64) {
    await run(
      pnpmCommand,
      ["exec", "node", "scripts/verify-test-package.mjs", "mac", "x64"],
      appDirectory
    );
  }
}

async function buildWindows(target, version) {
  if (!target.buildWinX64) return;
  await run(
    pnpmCommand,
    [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.yml",
      `--config.electronVersion=${version}`,
      "--win",
      "nsis",
      "--x64",
      "--publish",
      "never"
    ],
    appDirectory
  );
  await run(
    pnpmCommand,
    ["exec", "node", "scripts/verify-test-package.mjs", "win", "x64"],
    appDirectory
  );
}

async function buildLinux(target, version) {
  if (!target.buildLinuxX64) return;
  await run(
    pnpmCommand,
    [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.yml",
      `--config.electronVersion=${version}`,
      "--linux",
      "AppImage",
      "deb",
      "--x64",
      "--publish",
      "never"
    ],
    appDirectory
  );
  await run(
    pnpmCommand,
    ["exec", "node", "scripts/verify-test-package.mjs", "linux", "x64"],
    appDirectory
  );
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  if (
    target.buildMacArm64 ||
    (target.buildMacX64 && process.env.DEEPWRITE_SKIP_MAC_X64_SMOKE !== "1")
  ) {
    assertElectronLaunchAllowed();
  }
  const initialRuntime = await ensureElectronRuntime();
  const version = await electronVersion();
  console.log(
    `PACKAGE_RUNTIME_BASELINE version=${version} executable=${initialRuntime.executable}`
  );

  let packagingError;
  try {
    await run(pnpmCommand, ["verify"]);
    await buildLinux(target, version);
    await buildMac(target, version);
    await buildWindows(target, version);
  } catch (error) {
    packagingError = error;
  } finally {
    try {
      const finalRuntime = await ensureElectronRuntime();
      console.log(
        `PACKAGE_RUNTIME_POSTCHECK_OK version=${finalRuntime.version} executable=${finalRuntime.executable}`
      );
    } catch (runtimeError) {
      packagingError = packagingError
        ? new AggregateError(
            [packagingError, runtimeError],
            "测试包构建失败，并且 Electron 开发运行时恢复失败。"
          )
        : runtimeError;
    }
  }
  if (packagingError) throw packagingError;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    );
    process.exitCode = 1;
  });
}
