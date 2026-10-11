import type {
  CommandEnvelope,
  CommandResult,
  GeneralSettings,
  SystemEventEnvelope
} from "@deepwrite/contracts";
import type { BrowserWindow, Dialog } from "electron";
import { handleAgentTeamCommands } from "../ipc/agent-team-commands";
import type { ActiveRun, IpcCommandContext } from "../ipc/command-types";
import { handleCatalogProjectCommands } from "../ipc/catalog-project-commands";
import { handleSessionCommands } from "../ipc/session-commands";
import { handleLongCommands } from "../ipc/long-commands";
import {
  handleModelCommands,
  type ModelCommandContext
} from "../ipc/model-commands";
import { handleSettingsCommands } from "../ipc/settings-commands";
import { listRemoteModels } from "../list-remote-models";
import type { UtilitySupervisor } from "../supervisor";
import type { WorkspaceAgentConfigStore } from "../workspace-agent-config-store";
import type { AgentTeamConfigStore } from "../agent-team-config-store";
import type { LibraryAgentConfigStore } from "../library-agent-config-store";
import type { LongAgentConfigStore } from "../long-agent-config-store";
import type { ModelConfigStore } from "../model-config-store";
import type { ModelUsageStore } from "../model-usage-store";
import type { GeneralSettingsStore } from "../general-settings-store";
import type { WorkspaceDirectoryStore } from "../workspace-directory-store";
import {
  workspaceGroupParent,
  workspaceResourceParent
} from "../ipc/workspace-paths";
import { authorizeMainInternalCommand } from "../internal-command-authorizer";
import type { UsageRunContext } from "../usage-observation";
import { controlPlaneRouteKind } from "./allowlist";

const CORE_COMMAND_TIMEOUT_MS = 120_000;

export interface ControlPlaneStores {
  modelConfigStore: ModelConfigStore;
  modelUsageStore: ModelUsageStore;
  workspaceAgentConfigStore: WorkspaceAgentConfigStore;
  agentTeamConfigStore: AgentTeamConfigStore;
  libraryAgentConfigStore: LibraryAgentConfigStore;
  longAgentConfigStore: LongAgentConfigStore;
  generalSettingsStore: GeneralSettingsStore;
  workspaceDirectoryStore: WorkspaceDirectoryStore;
}

export interface ControlPlaneParams {
  supervisor: UtilitySupervisor;
  stores: ControlPlaneStores;
  /** Shared with index.ts so agent-run event mirrors stay authoritative. */
  activeRuns: Map<string, ActiveRun>;
  terminalRuns: Set<string>;
  pendingUsageContexts: Map<string, UsageRunContext>;
  broadcastEvent: (event: SystemEventEnvelope) => void;
  getMainWindow: () => BrowserWindow | undefined;
  syncGeneralSettings: (settings: GeneralSettings) => void;
  requireSelectedWorkspaceDirectory: () => Promise<string | null>;
  getDocumentsPath: () => string;
  getAppVersion: () => string;
}

function forbiddenDialog(): never {
  throw new Error("控制面白名单命令不支持原生对话框操作。");
}

/** Stub that fails loudly when any property is touched. */
function unusable<T>(label: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`控制面不支持该能力：${label}`);
      }
    }
  ) as T;
}

/**
 * Builds the shared handler context. Only fields touched by allowlisted
 * commands are wired to real services; everything else fails loudly when
 * touched, so an allowlist mistake surfaces instead of silently misbehaving.
 */
function buildIpcContext(params: ControlPlaneParams): IpcCommandContext {
  const dialog = forbiddenDialog as unknown as Pick<
    Dialog,
    "showOpenDialog" | "showSaveDialog"
  >;
  const requireMainWindow = () => {
    const win = params.getMainWindow();
    if (!win) throw new Error("control_plane.no_main_window");
    return win;
  };
  return {
    getMainWindow: requireMainWindow,
    supervisor: params.supervisor,
    broadcastEvent: params.broadcastEvent,
    dialog,
    continuationImportPreviews: unusable("continuationImportPreviews"),
    legacySyncPreviews: unusable("legacySyncPreviews"),
    authorizeMainInternalCommand,
    activeRuns: params.activeRuns,
    pendingUsageContexts: params.pendingUsageContexts,
    terminalRuns: params.terminalRuns,
    recordUsageObservation: () => undefined,
    requireModelConfigStore: () => params.stores.modelConfigStore,
    requireModelUsageStore: () => params.stores.modelUsageStore,
    requireWorkspaceAgentConfigStore: () =>
      params.stores.workspaceAgentConfigStore,
    requireAgentTeamConfigStore: () => params.stores.agentTeamConfigStore,
    requireLibraryAgentConfigStore: () => params.stores.libraryAgentConfigStore,
    requireLongAgentConfigStore: () => params.stores.longAgentConfigStore,
    requireWorkspaceDirectoryStore: () => params.stores.workspaceDirectoryStore,
    requireAppearanceService: forbiddenDialog as never,
    requireGeneralSettingsStore: () => params.stores.generalSettingsStore,
    exportShortManuscript: forbiddenDialog as never,
    exportLongManuscript: forbiddenDialog as never,
    listRemoteModels,
    resolveDraftApiKey: (input) =>
      params.stores.modelConfigStore.resolveDraftApiKey(input),
    cachedAppearanceSettings: forbiddenDialog as never,
    readExternalLibraryEntries: unusable("readExternalLibraryEntries"),
    syncNativeAppearanceChrome: () => undefined,
    syncGeneralSettings: params.syncGeneralSettings,
    requireSelectedWorkspaceDirectory: params.requireSelectedWorkspaceDirectory,
    workspaceResourceParent,
    workspaceGroupParent,
    chooseWorkspaceDirectory: forbiddenDialog as never,
    senderWebContentsId: 0,
    getDocumentsPath: params.getDocumentsPath,
    getAppVersion: params.getAppVersion
  };
}

function buildModelContext(params: ControlPlaneParams): ModelCommandContext {
  return {
    requireModelConfigStore: () => params.stores.modelConfigStore,
    requireModelUsageStore: () => params.stores.modelUsageStore,
    listRemoteModels,
    supervisor: params.supervisor
  };
}

async function requestCore(
  params: ControlPlaneParams,
  command: CommandEnvelope
): Promise<CommandResult> {
  return params.supervisor.requestCommand(
    "core",
    command,
    CORE_COMMAND_TIMEOUT_MS
  );
}

export async function dispatchControlPlaneCommand(
  params: ControlPlaneParams,
  command: CommandEnvelope
): Promise<CommandResult> {
  const kind = controlPlaneRouteKind(command.type);
  if (!kind) {
    return {
      status: "rejected",
      requestId: command.id,
      error: {
        code: "control_plane.command_not_allowed",
        message: `命令 ${command.type} 不在控制面白名单内。`
      }
    };
  }
  if (kind === "core-read" || kind === "core-write") {
    return requestCore(params, command);
  }
  const ipcContext = buildIpcContext(params);
  if (
    command.type.startsWith("models.") ||
    command.type.startsWith("modelUsage.")
  ) {
    return (
      (await handleModelCommands(buildModelContext(params), command)) ?? {
        status: "rejected",
        requestId: command.id,
        error: { code: "control_plane.unhandled", message: "命令未被处理。" }
      }
    );
  }
  if (
    command.type.startsWith("workspaceDirectory.") ||
    command.type.startsWith("generalSettings.") ||
    command.type.startsWith("workspaceAgents.") ||
    command.type.startsWith("longAgents.") ||
    command.type.startsWith("libraryAgents.")
  ) {
    return (
      (await handleSettingsCommands(ipcContext, command)) ?? {
        status: "rejected",
        requestId: command.id,
        error: { code: "control_plane.unhandled", message: "命令未被处理。" }
      }
    );
  }
  if (command.type.startsWith("agentTeams.")) {
    return (
      (await handleAgentTeamCommands(ipcContext, command)) ?? {
        status: "rejected",
        requestId: command.id,
        error: { code: "control_plane.unhandled", message: "命令未被处理。" }
      }
    );
  }
  if (command.type.startsWith("catalog.")) {
    return (
      (await handleCatalogProjectCommands(ipcContext, command)) ?? {
        status: "rejected",
        requestId: command.id,
        error: { code: "control_plane.unhandled", message: "命令未被处理。" }
      }
    );
  }
  if (command.type.startsWith("session.")) {
    return (
      (await handleSessionCommands(ipcContext, command)) ?? {
        status: "rejected",
        requestId: command.id,
        error: { code: "control_plane.unhandled", message: "命令未被处理。" }
      }
    );
  }
  if (command.type === "long.createBook") {
    return (
      (await handleLongCommands(ipcContext, command)) ?? {
        status: "rejected",
        requestId: command.id,
        error: { code: "control_plane.unhandled", message: "命令未被处理。" }
      }
    );
  }
  return {
    status: "rejected",
    requestId: command.id,
    error: {
      code: "control_plane.command_not_allowed",
      message: `命令 ${command.type} 不在控制面白名单内。`
    }
  };
}
