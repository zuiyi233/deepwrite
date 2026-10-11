import { describe, expect, it } from "vitest";
import { controlPlaneRouteKind, isControlPlaneWrite } from "./allowlist";

describe("controlPlaneRouteKind", () => {
  it("classifies read commands", () => {
    expect(controlPlaneRouteKind("models.list")).toBe("read");
    expect(controlPlaneRouteKind("longAgents.list")).toBe("read");
    expect(controlPlaneRouteKind("agentTeams.list")).toBe("read");
    expect(controlPlaneRouteKind("workspaceDirectory.list")).toBe("read");
  });

  it("classifies write commands", () => {
    expect(controlPlaneRouteKind("models.save")).toBe("write");
    expect(controlPlaneRouteKind("longAgents.save")).toBe("write");
    expect(controlPlaneRouteKind("long.createBook")).toBe("write");
    expect(controlPlaneRouteKind("catalog.createLibrary")).toBe("write");
  });

  it("classifies core passthrough commands", () => {
    expect(controlPlaneRouteKind("long.getWorkspaceIndex")).toBe("core-read");
    expect(controlPlaneRouteKind("long.readDocument")).toBe("core-read");
    expect(controlPlaneRouteKind("long.search")).toBe("core-read");
    expect(controlPlaneRouteKind("catalog.previewLibraryPackageAtPath")).toBe(
      "core-write"
    );
    expect(controlPlaneRouteKind("catalog.importLibraryPackageAtPath")).toBe(
      "core-write"
    );
  });

  it("rejects anything not allowlisted, including renderer-forbidden internals", () => {
    expect(controlPlaneRouteKind("agent.prompt")).toBeUndefined();
    expect(controlPlaneRouteKind("session.rendererState")).toBeUndefined();
    expect(controlPlaneRouteKind("models.refreshFree")).toBeUndefined();
    expect(controlPlaneRouteKind("")).toBeUndefined();
  });

  it("flags writes for audit logging", () => {
    expect(isControlPlaneWrite("models.save")).toBe(true);
    expect(isControlPlaneWrite("catalog.importLibraryPackageAtPath")).toBe(
      true
    );
    expect(isControlPlaneWrite("models.list")).toBe(false);
  });
});
