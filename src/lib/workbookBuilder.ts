/**
 * Runs the skill's own workbook builder (agent/skills/plusim-reports/scripts/
 * build_report_xlsx.py) as a child process, so the app and the agent produce
 * the Excel with ONE builder (docs/plans/report-adjust-chat.md B7). Fixed argv,
 * no shell, input on stdin, output in a fresh temp dir removed afterwards.
 * Needs python3 + openpyxl in the image (nixpacks.toml, plan B8).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BUILDER_SCRIPT = path.join(
  process.cwd(),
  "agent",
  "skills",
  "plusim-reports",
  "scripts",
  "build_report_xlsx.py",
);
export const BUILDER_TIMEOUT_MS = 60_000;

export interface WorkbookInput {
  taxonomy: { section: string; leaves: string[] }[];
  txns: Record<string, unknown>[];
}

export async function runWorkbookBuilder(input: WorkbookInput): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plusim-wb-"));
  const out = path.join(dir, "report.xlsx");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "python3",
        [BUILDER_SCRIPT, "--out", out],
        { timeout: BUILDER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`workbook builder failed: ${err.message}${stderr ? ` — ${String(stderr).slice(-500)}` : ""}`));
          else resolve();
        },
      );
      child.stdin?.on("error", () => {}); // a crashed child closes stdin; the callback reports it
      child.stdin?.end(JSON.stringify(input));
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Boot-time check that the builder can run here; logs one clear line, never throws. */
export async function checkWorkbookBuilder(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("python3", ["-c", "import openpyxl"], { timeout: 15_000 }, (err) => {
      if (err) {
        console.error(
          "[workbook] python3 + openpyxl NOT available — chat edits will not rebuild the Excel (see nixpacks.toml)",
        );
        resolve(false);
      } else {
        console.log("[workbook] python3 + openpyxl available");
        resolve(true);
      }
    });
  });
}
