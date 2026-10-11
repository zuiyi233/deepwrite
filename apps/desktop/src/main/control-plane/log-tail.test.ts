import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tailStartupLog } from "./log-tail";

async function makeDiagnosticsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dw-control-plane-log-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("tailStartupLog", () => {
  it("returns the last N lines of the current log", async () => {
    const dir = await makeDiagnosticsDir();
    const lines = Array.from({ length: 30 }, (_, i) => `{"n":${i}}`);
    await writeFile(join(dir, "startup.log"), lines.join("\n"), "utf-8");
    const tail = tailStartupLog(dir, 5);
    expect(tail).toEqual(lines.slice(-5));
  });

  it("spills into startup.log.previous when the current log is short", async () => {
    const dir = await makeDiagnosticsDir();
    await writeFile(
      join(dir, "startup.log.previous"),
      ["a", "b", "c"].join("\n"),
      "utf-8"
    );
    await writeFile(join(dir, "startup.log"), ["d", "e"].join("\n"), "utf-8");
    expect(tailStartupLog(dir, 4)).toEqual(["b", "c", "d", "e"]);
  });

  it("returns an empty array when no log exists", async () => {
    const dir = await makeDiagnosticsDir();
    expect(tailStartupLog(dir, 10)).toEqual([]);
  });

  it("truncates oversized lines", async () => {
    const dir = await makeDiagnosticsDir();
    await writeFile(join(dir, "startup.log"), "x".repeat(10_000), "utf-8");
    const tail = tailStartupLog(dir, 10);
    const first = tail[0] ?? "";
    expect(tail).toHaveLength(1);
    expect(first.length).toBeLessThan(4_100);
    expect(first.endsWith("…")).toBe(true);
  });
});
