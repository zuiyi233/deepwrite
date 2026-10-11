import { createServer, type IncomingMessage } from "node:http";
import type { CommandEnvelope } from "@deepwrite/contracts";
import { CommandEnvelopeSchema } from "@deepwrite/contracts";
import { isAuthorized } from "./auth";
import {
  buildConfigMap,
  loadControlPlaneConfig,
  type ResolvedControlPlaneConfig
} from "./config";
import { tailStartupLog } from "./log-tail";
import { dispatchControlPlaneCommand, type ControlPlaneParams } from "./routes";

export interface StartControlPlaneOptions extends ControlPlaneParams {
  userDataPath: string;
  diagnosticsDir: string;
  startupLogPath: string;
  log: (event: string, details?: Record<string, unknown>) => void;
}

export interface ControlPlaneHandle {
  enabled: boolean;
  port?: number;
  close?: () => void;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Starts the loopback-only control plane when enabled via
 * config/control-plane.json or DEEPWRITE_CONTROL_PLANE. Never throws into
 * app startup: failures are logged and the plane stays off.
 */
export async function startControlPlane(
  options: StartControlPlaneOptions
): Promise<ControlPlaneHandle> {
  let config: ResolvedControlPlaneConfig;
  try {
    config = loadControlPlaneConfig(options.userDataPath);
  } catch (error: unknown) {
    options.log("control-plane.config_error", {
      reason: error instanceof Error ? error.message : "UNKNOWN"
    });
    return { enabled: false };
  }
  if (!config.enabled) return { enabled: false };

  const server = createServer((request, response) => {
    void handleRequest(options, config, request, response).catch(
      (error: unknown) => {
        options.log("control-plane.request_error", {
          reason: error instanceof Error ? error.message : "UNKNOWN"
        });
        if (!response.headersSent) {
          respondJson(response, 500, {
            error: "control_plane.internal_error"
          });
        } else {
          response.end();
        }
      }
    );
  });
  server.on("error", (error: Error) => {
    options.log("control-plane.listen_error", { reason: error.message });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, "127.0.0.1", resolveListen);
  });
  options.log("control-plane.started", {
    port: config.port,
    tokenGenerated: config.tokenGenerated
  });
  return {
    enabled: true,
    port: config.port,
    close: () => server.close()
  };
}

async function handleRequest(
  options: StartControlPlaneOptions,
  config: ResolvedControlPlaneConfig,
  request: IncomingMessage,
  response: import("node:http").ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = `${request.method} ${url.pathname}`;

  if (!isAuthorized(request.headers.authorization, config.token)) {
    options.log("control-plane.unauthorized", { route });
    respondJson(response, 401, { error: "control_plane.unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const workspace = await options.stores.workspaceDirectoryStore.list();
    respondJson(response, 200, {
      ok: true,
      appVersion: options.getAppVersion(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      workspacePath: workspace.path,
      controlPlane: { port: config.port, configPath: config.configPath }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/config-map") {
    const workspace = await options.stores.workspaceDirectoryStore.list();
    respondJson(
      response,
      200,
      buildConfigMap(
        options.userDataPath,
        workspace.path,
        options.startupLogPath
      )
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/logs/tail") {
    const lines = Number(url.searchParams.get("lines") ?? "200");
    respondJson(response, 200, {
      lines: tailStartupLog(
        options.diagnosticsDir,
        Number.isFinite(lines) ? lines : 200
      )
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/command") {
    const body = await readBody(request);
    let envelope: CommandEnvelope;
    try {
      envelope = CommandEnvelopeSchema.parse(JSON.parse(body));
    } catch (error: unknown) {
      respondJson(response, 400, {
        error: "control_plane.invalid_command",
        message: error instanceof Error ? error.message : "UNKNOWN"
      });
      return;
    }
    const result = await dispatchControlPlaneCommand(options, envelope);
    if (result.status === "accepted") {
      options.log("control-plane.command_accepted", { type: envelope.type });
    } else {
      options.log("control-plane.command_rejected", {
        type: envelope.type,
        code: result.error.code
      });
    }
    respondJson(response, 200, result);
    return;
  }

  respondJson(response, 404, { error: "control_plane.not_found", route });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error("control_plane.body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolveBody(Buffer.concat(chunks).toString("utf-8"))
    );
    request.on("error", rejectBody);
  });
}

function respondJson(
  response: import("node:http").ServerResponse,
  status: number,
  payload: unknown
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
