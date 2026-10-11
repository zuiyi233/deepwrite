import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTROL_PLANE_DEFAULT_PORT = 7630;

export interface ControlPlaneFileConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface ResolvedControlPlaneConfig {
  enabled: boolean;
  port: number;
  token: string;
  configPath: string;
  /** True when the token was generated and persisted by this load. */
  tokenGenerated: boolean;
}

function parseControlPlaneFile(raw: unknown): ControlPlaneFileConfig {
  if (raw !== null && typeof raw !== "object") {
    throw new Error("control_plane.config_not_an_object");
  }
  const source = (raw ?? {}) as Record<string, unknown>;
  const enabled = source.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("control_plane.config_enabled_not_boolean");
  }
  const port = source.port;
  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65_535)
  ) {
    throw new Error("control_plane.config_port_out_of_range");
  }
  const token = source.token;
  if (token !== undefined && typeof token !== "string") {
    throw new Error("control_plane.config_token_not_string");
  }
  return {
    enabled: enabled ?? false,
    port: port === undefined ? CONTROL_PLANE_DEFAULT_PORT : (port as number),
    token: typeof token === "string" ? token.trim() : ""
  };
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/**
 * Loads config/control-plane.json from the user-data directory. The
 * DEEPWRITE_CONTROL_PLANE environment variable ("1"/"0") overrides `enabled`.
 * A missing token is generated once and persisted; malformed JSON throws so
 * the caller can disable the plane loudly instead of guessing.
 */
export function loadControlPlaneConfig(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedControlPlaneConfig {
  const configPath = join(userDataPath, "config", "control-plane.json");
  let parsed: ControlPlaneFileConfig;
  try {
    const content = readFileSync(configPath, "utf-8");
    parsed = parseControlPlaneFile(JSON.parse(content));
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      parsed = parseControlPlaneFile({});
    } else {
      throw error;
    }
  }

  let enabled = parsed.enabled;
  const envEnabled = env.DEEPWRITE_CONTROL_PLANE?.trim();
  if (envEnabled === "1") enabled = true;
  if (envEnabled === "0") enabled = false;

  let port = parsed.port;
  const envPort = Number(env.DEEPWRITE_CONTROL_PLANE_PORT?.trim());
  if (
    enabled &&
    Number.isSafeInteger(envPort) &&
    envPort >= 1 &&
    envPort <= 65_535
  ) {
    port = envPort;
  }

  let token = parsed.token;
  let tokenGenerated = false;
  if (enabled && !token) {
    token = randomBytes(32).toString("hex");
    tokenGenerated = true;
    writeAtomic(
      configPath,
      `${JSON.stringify({ ...parsed, enabled, token }, null, 2)}\n`
    );
  }

  return { enabled, port, token, configPath, tokenGenerated };
}

export interface ControlPlaneEndpointMap {
  models: string;
  workspaceDirectory: string;
  generalSettings: string;
  appearance: string;
  agentTeams: string;
  libraryAgents: string;
  longAgents: string;
  workspaceAgents: string;
  extrasAgents: string;
  catalogRegistry: string;
  startupLog: string;
  skillLibraries: string;
  materialLibraries: string;
}

/** On-disk locations AI clients can read directly; writes go through /command. */
export function buildConfigMap(
  userDataPath: string,
  workspacePath: string | null,
  startupLogPath: string
): ControlPlaneEndpointMap {
  const configDir = join(userDataPath, "config");
  const workspace = workspacePath ?? "<未设置工作目录>";
  return {
    models: join(configDir, "models.json"),
    workspaceDirectory: join(configDir, "workspace-directory.json"),
    generalSettings: join(configDir, "general-settings.json"),
    appearance: join(configDir, "appearance.json"),
    agentTeams: join(configDir, "agent-team-profiles.json"),
    libraryAgents: join(configDir, "library-agents.json"),
    longAgents: join(configDir, "long-workspace-agents.json"),
    workspaceAgents: join(configDir, "workspace-agents.json"),
    extrasAgents: join(configDir, "extras-agents"),
    catalogRegistry: join(userDataPath, "catalog-registry.json"),
    startupLog: startupLogPath,
    skillLibraries: join(workspace, "skills"),
    materialLibraries: join(workspace, "materials")
  };
}
