import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LINE_BYTES = 4_000;

/**
 * Returns the last `lines` entries of diagnostics/startup.log, spilling over
 * into startup.log.previous when the current file alone is too short. Each
 * line is truncated so a giant payload cannot blow up the HTTP response.
 */
export function tailStartupLog(
  diagnosticsDir: string,
  lines = 200,
  currentFileName = "startup.log"
): string[] {
  const capped = Math.max(1, Math.min(1_000, Math.floor(lines)));
  const current = readLinesSafely(join(diagnosticsDir, currentFileName));
  if (current.length >= capped || currentFileName !== "startup.log") {
    return takeLast(current, capped);
  }
  const previous = readLinesSafely(
    join(diagnosticsDir, "startup.log.previous")
  );
  return takeLast([...previous, ...current], capped);
}

function readLinesSafely(path: string): string[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) =>
        line.length > MAX_LINE_BYTES
          ? `${line.slice(0, MAX_LINE_BYTES)}…`
          : line
      );
  } catch {
    return [];
  }
}

function takeLast(values: string[], count: number): string[] {
  return values.slice(Math.max(0, values.length - count));
}
