/**
 * Every error message a person can read must be in Hebrew.
 *
 * The admin UI renders `data.error` from these routes verbatim (see
 * ReportJobDetail / DriveBrowser / FileEditor), so an English literal here is an
 * English notification on screen. Scanned statically instead of per-route tests:
 * one check, and it catches the next route too.
 *
 * Out of scope on purpose: /api/agent/** (agent-to-server, machine-read) and
 * /api/chat (the client maps HTTP status → Hebrew in plusimRuntime.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// src/worker is in scope because the dispatch worker writes ReportJob.error,
// which the job page renders verbatim — that is how "dispatch failed: agentglob
// 401" reached an admin's screen.
const ROOTS = ["src/app/admin/api", "src/app/api/reports", "src/worker"];
const EXTRA_FILES = [
  "src/lib/reportStatementUpload.ts",
  "src/lib/reportsAdminAuth.ts",
  "src/lib/driveAuth.ts",
  "src/lib/agentglob.ts",
];

const HEBREW = /[\u0590-\u05FF]/;
// `error: "…"` / `exportNote = "…"` — the message shapes the UI prints. The
// leading `{`/`,`/`(`/line-start anchor keeps it to real property writes: without
// it, a log line like console.error("[worker] queue error:", e) matched its own
// closing quote and swallowed the next line as a false positive.
const ERROR_LITERAL =
  /(?:^|[{,(]\s*)(?:error|exportNote)\s*[:=]\s*(["`])((?:\\.|(?!\1)[\s\S])*)\1/gm;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("user-facing error messages are Hebrew", () => {
  const files = [...ROOTS.flatMap(tsFiles), ...EXTRA_FILES];

  it("scans the routes people actually see", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const offenders = [...src.matchAll(ERROR_LITERAL)]
      .map((m) => m[2])
      .filter((msg) => !HEBREW.test(msg));
    it(`${file} has no English error text`, () => {
      expect(offenders).toEqual([]);
    });
  }
});
