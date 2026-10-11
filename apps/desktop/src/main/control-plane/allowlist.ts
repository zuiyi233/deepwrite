import type { CommandEnvelope } from "@deepwrite/contracts";

/**
 * Explicit command allowlist for the local control plane. The plane is a
 * Main-internal caller: it does NOT inherit the renderer forbidden-list
 * semantics, but it only ever dispatches commands listed here. Anything not
 * listed is rejected before reaching a handler.
 */
export const CONTROL_PLANE_READ_COMMANDS = [
  "models.list",
  "models.listRemote",
  "models.test",
  "modelUsage.query",
  "workspaceDirectory.list",
  "generalSettings.list",
  "workspaceAgents.list",
  "longAgents.list",
  "libraryAgents.list",
  "agentTeams.list",
  "catalog.openProject"
] as const satisfies readonly CommandEnvelope["type"][];

export const CONTROL_PLANE_WRITE_COMMANDS = [
  "models.save",
  "generalSettings.save",
  "workspaceAgents.save",
  "workspaceAgents.reset",
  "longAgents.save",
  "longAgents.reset",
  "libraryAgents.save",
  "libraryAgents.reset",
  "agentTeams.save",
  "agentTeams.setEnabled",
  "agentTeams.create",
  "agentTeams.rename",
  "agentTeams.delete",
  "catalog.createLibrary",
  "catalog.createLibraryGroup",
  "long.createBook",
  "session.prompt",
  "session.abort",
  "session.user_input_response"
] as const satisfies readonly CommandEnvelope["type"][];

/**
 * Read-only queries executed directly against the core utility worker, same
 * route the agent bridge uses for accepted runs. No renderer handler involved.
 */
export const CONTROL_PLANE_CORE_READ_COMMANDS = [
  "long.list",
  "long.open",
  "long.getWorkspaceIndex",
  "long.readDocument",
  "long.search"
] as const satisfies readonly CommandEnvelope["type"][];

/**
 * Headless library-package import via explicit paths (no native dialogs):
 * preview scans a folder/zip on disk, import materializes the libraries.
 * `long.updateBindings` rewrites a book's linked skill/material libraries.
 */
export const CONTROL_PLANE_CORE_WRITE_COMMANDS = [
  "long.updateBindings",
  "catalog.previewLibraryPackageAtPath",
  "catalog.importLibraryPackageAtPath"
] as const satisfies readonly CommandEnvelope["type"][];

const READ = new Set<string>(CONTROL_PLANE_READ_COMMANDS);
const WRITE = new Set<string>(CONTROL_PLANE_WRITE_COMMANDS);
const CORE_READ = new Set<string>(CONTROL_PLANE_CORE_READ_COMMANDS);
const CORE_WRITE = new Set<string>(CONTROL_PLANE_CORE_WRITE_COMMANDS);

export type ControlPlaneRouteKind =
  "read" | "write" | "core-read" | "core-write";

export function controlPlaneRouteKind(
  type: string
): ControlPlaneRouteKind | undefined {
  if (READ.has(type)) return "read";
  if (WRITE.has(type)) return "write";
  if (CORE_READ.has(type)) return "core-read";
  if (CORE_WRITE.has(type)) return "core-write";
  return undefined;
}

export function isControlPlaneWrite(type: string): boolean {
  return WRITE.has(type) || CORE_WRITE.has(type);
}
