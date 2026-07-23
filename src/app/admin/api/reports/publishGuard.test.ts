/**
 * Publish guards. What reaches the client must be the exact result the app
 * verified, from the newest run, covering every statement the job lists.
 *
 * Original rule: a job carrying FATAL verification diagnostics must never
 * publish (409, no Sheet export, status unchanged); a non-fatal job (clean, or
 * merely uncategorized) publishes.
 *
 * Added by the plan review of PR #23 (update-a-ready-report):
 *   publish_with_unprocessed_files_409, publish_append_race_conditional_409,
 *   publish_reverse_result_race_409, publish_rejected_callback_race_409,
 *   publish_same_millisecond_append_409, republish_updates_sheet_in_place,
 *   republish_sheet_outside_user_folder_falls_back,
 *   republish_sheet_update_falls_back_to_create,
 *   republish_failed_export_clears_sheet_url, republish_folder_outside_root_409.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), updateMany: vi.fn() },
    reportTransaction: { count: vi.fn() },
    reportArtifact: { findFirst: vi.fn() },
    statementFile: { count: vi.fn() },
    userDriveFolder: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/googleDrive", () => ({
  isDriveConnected: vi.fn(),
  assertEntryUnderRoot: vi.fn(),
  assertEntryUnderFolder: vi.fn(),
  uploadXlsxAsSpreadsheet: vi.fn(),
  updateXlsxSpreadsheet: vi.fn(),
  trashFile: vi.fn(),
}));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import * as drive from "@/lib/googleDrive";
import { POST as publishPOST } from "./[jobId]/publish/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdateMany = db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>;
const txCount = db.reportTransaction.count as unknown as ReturnType<typeof vi.fn>;
const artifactFind = db.reportArtifact.findFirst as unknown as ReturnType<typeof vi.fn>;
const fileCount = db.statementFile.count as unknown as ReturnType<typeof vi.fn>;
const folderFind = db.userDriveFolder.findUnique as unknown as ReturnType<typeof vi.fn>;
const driveConnected = drive.isDriveConnected as unknown as ReturnType<typeof vi.fn>;
const assertRoot = drive.assertEntryUnderRoot as unknown as ReturnType<typeof vi.fn>;
const assertFolder = drive.assertEntryUnderFolder as unknown as ReturnType<typeof vi.fn>;
const createSheet = drive.uploadXlsxAsSpreadsheet as unknown as ReturnType<typeof vi.fn>;
const updateSheet = drive.updateXlsxSpreadsheet as unknown as ReturnType<typeof vi.fn>;
const trash = drive.trashFile as unknown as ReturnType<typeof vi.fn>;

const req = () => new NextRequest("https://plusim.xyz/admin/api/reports/jobA/publish", { method: "POST" });
const params = { params: Promise.resolve({ jobId: "jobA" }) };

const DISPATCHED = new Date("2026-07-20T10:00:00.000Z");
const COMPLETED = new Date("2026-07-20T10:05:00.000Z");

/** A publishable job: clean result, newer than its dispatch. */
function job(over: Record<string, unknown> = {}) {
  return {
    id: "jobA",
    status: "completed",
    targetUserId: "u1",
    title: "t",
    sheetUrl: null,
    verification: { fatal: false, problems: [] },
    dispatchedAt: DISPATCHED,
    completedAt: COMPLETED,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  txCount.mockResolvedValue(0);
  fileCount.mockResolvedValue(0); // no files newer than the dispatch
  jobUpdateMany.mockResolvedValue({ count: 1 });
  driveConnected.mockResolvedValue(false); // skip Sheet export unless a test opts in
});

/** Turn on a working Drive with an assigned folder and a stored artifact. */
function withDrive() {
  driveConnected.mockResolvedValue(true);
  folderFind.mockResolvedValue({ userId: "u1", folderId: "folder-1" });
  artifactFind.mockResolvedValue({ id: "art-1", filename: "report.xlsx", bytes: Buffer.from("PKxlsx") });
  assertRoot.mockResolvedValue({ id: "folder-1" });
  assertFolder.mockResolvedValue({ id: "sheet-1" });
  createSheet.mockResolvedValue({ id: "sheet-new" });
  updateSheet.mockResolvedValue({ id: "sheet-1" });
  trash.mockResolvedValue(undefined);
}

const FATAL_CLASSES: Record<string, unknown> = {
  "total mismatch": { fatal: true, problems: ['source "x": recomputed 1 ≠ statement 2 agorot'] },
  "duplicate dedupKey": { fatal: true, problems: ["duplicate dedupKey v-1"] },
  "date outside month": { fatal: true, problems: ["txn date 2026-07-01 outside its month 2026-06"] },
  "unknown category": { fatal: true, problems: ['unknown category "zzz"'] },
  "non-xlsx payload": { fatal: true, problems: ["xlsx payload is not a valid zip container"] },
};

describe("publish refuses every fatal class", () => {
  for (const [name, verification] of Object.entries(FATAL_CLASSES)) {
    it(`${name} → 409, nothing published`, async () => {
      jobFind.mockResolvedValue(job({ status: "needs_review", verification }));
      const res = await publishPOST(req(), params);
      expect(res.status).toBe(409);
      expect(jobUpdateMany).not.toHaveBeenCalled();
    });
  }
});

describe("publish allows non-fatal jobs", () => {
  it("clean completed job → published", async () => {
    jobFind.mockResolvedValue(job());
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "published" }) }),
    );
  });

  it("non-fatal job with only uncategorized rows → published", async () => {
    jobFind.mockResolvedValue(job({ status: "needs_review" }));
    txCount.mockResolvedValue(3); // uncategorized rows remain — still publishable
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "published" }) }),
    );
  });
});

describe("result freshness — the artifact must come from the newest run", () => {
  it("publish_rejected_callback_race_409 — rejected re-run left the OLD result behind", async () => {
    // The rejected path writes status/error only: completedAt stays older than
    // the latest dispatchedAt, and no file is newer than that dispatch.
    jobFind.mockResolvedValue(
      job({ status: "needs_review", dispatchedAt: new Date("2026-07-21T09:00:00.000Z") }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(409);
    expect(jobUpdateMany).not.toHaveBeenCalled();
    expect(createSheet).not.toHaveBeenCalled();
  });

  it("publish_rejected_callback_race_409 — first result ever was rejected (completedAt null)", async () => {
    jobFind.mockResolvedValue(job({ status: "needs_review", completedAt: null }));
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(409);
    expect(jobUpdateMany).not.toHaveBeenCalled();
  });
});

describe("file coverage — every listed statement must have been through the run", () => {
  it("publish_with_unprocessed_files_409 — appended after the last dispatch", async () => {
    jobFind.mockResolvedValue(job());
    fileCount.mockResolvedValue(2);
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(409);
    expect(jobUpdateMany).not.toHaveBeenCalled();
    expect(createSheet).not.toHaveBeenCalled();
  });

  it("publish_same_millisecond_append_409 — the boundary is gte, not gt", async () => {
    jobFind.mockResolvedValue(job());
    await publishPOST(req(), params);
    expect(fileCount).toHaveBeenCalledWith({
      where: { jobId: "jobA", createdAt: { gte: DISPATCHED } },
    });
  });

  it("publish_append_race_conditional_409 — the write re-asserts the file set", async () => {
    jobFind.mockResolvedValue(job());
    jobUpdateMany.mockResolvedValue({ count: 0 }); // a file landed between pre-check and write
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(409);
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          files: { none: { createdAt: { gte: DISPATCHED } } },
        }),
      }),
    );
  });

  it("publish_reverse_result_race_409 — the write pins both watermarks", async () => {
    jobFind.mockResolvedValue(job());
    jobUpdateMany.mockResolvedValue({ count: 0 }); // a fresh (fatal) result landed meanwhile
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(409);
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dispatchedAt: DISPATCHED, completedAt: COMPLETED }),
      }),
    );
  });
});

describe("sheet export on re-publish", () => {
  it("republish_updates_sheet_in_place — same id, contained first, no new sheet", async () => {
    withDrive();
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(assertRoot).toHaveBeenCalledWith("folder-1");
    expect(assertFolder).toHaveBeenCalledWith("sheet-1", "folder-1");
    expect(updateSheet).toHaveBeenCalledWith(expect.objectContaining({ fileId: "sheet-1" }));
    expect(createSheet).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
    });
  });

  it("republish_sheet_outside_user_folder_falls_back — no in-place write, and NO trash of an uncontained id", async () => {
    withDrive();
    assertFolder.mockRejectedValue(new Error("not under the user's folder"));
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(updateSheet).not.toHaveBeenCalled();
    expect(createSheet).toHaveBeenCalledWith(expect.objectContaining({ parentFolderId: "folder-1" }));
    // A sheet that failed containment may sit in ANOTHER client's folder.
    // Trashing is a write — never against an id we just refused (code review #25).
    expect(trash).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit",
    });
  });

  it("republish_trashes_superseded_sheet_only_after_the_publish_commits", async () => {
    withDrive();
    updateSheet.mockRejectedValue(new Error("drive 404")); // contained, but unwritable
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(assertFolder).toHaveBeenCalledWith("sheet-1", "folder-1");
    expect(trash).toHaveBeenCalledWith("sheet-1");
    // Order matters: the DB write commits first, so a raced publish cannot trash
    // a sheet that is still the live one.
    expect(jobUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(trash.mock.invocationCallOrder[0]);
  });

  it("a raced publish (0 rows) trashes nothing — the old sheet stays live", async () => {
    withDrive();
    updateSheet.mockRejectedValue(new Error("drive 404"));
    jobUpdateMany.mockResolvedValue({ count: 0 });
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(409);
    expect(trash).not.toHaveBeenCalled();
  });

  it("republish_sheet_update_falls_back_to_create — update throws", async () => {
    withDrive();
    updateSheet.mockRejectedValue(new Error("drive 404"));
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(createSheet).toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit",
    });
  });

  it("a failed trash of the superseded sheet keeps the NEW link (found in implementation)", async () => {
    withDrive();
    updateSheet.mockRejectedValue(new Error("drive 404"));
    trash.mockRejectedValue(new Error("drive 403"));
    jobUpdateMany.mockResolvedValue({ count: 1 });
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    // Cleanup is best-effort: it must never escape and discard a link that the
    // create step just produced (that path once cleared sheetUrl instead).
    await expect(res.json()).resolves.toMatchObject({
      sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit",
    });
  });

  it("republish_failed_export_clears_sheet_url — both paths fail ⇒ no stale link", async () => {
    withDrive();
    updateSheet.mockRejectedValue(new Error("drive 500"));
    createSheet.mockRejectedValue(new Error("drive 500"));
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200); // export is best-effort — publish still succeeds
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sheetUrl: null }) }),
    );
    const body = await res.json();
    expect(body.sheetUrl).toBeNull();
    expect(body.exportNote).toMatch(/stale sheet link cleared/);
  });

  it("republish_folder_outside_root_409 — assigned folder left the root ⇒ no Drive write at all", async () => {
    // The "409" in the banked name is the containment refusal, not the HTTP
    // status: export is best-effort, so publish itself still succeeds.
    withDrive();
    assertRoot.mockRejectedValue(new Error("outside root"));
    jobFind.mockResolvedValue(
      job({ status: "published", sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" }),
    );
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(updateSheet).not.toHaveBeenCalled();
    expect(createSheet).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sheetUrl: null }) }),
    );
  });

  // A skip is not a success: if this publish did not put the current workbook in
  // Drive, an existing link points at the PREVIOUS one and must go (code review
  // #25 round 2 — the clearing rule originally covered only the throw path).
  describe("republish_skip_paths_clear_stale_sheet_url", () => {
    const STALE = "https://docs.google.com/spreadsheets/d/sheet-1/edit";

    it("Drive disconnected", async () => {
      driveConnected.mockResolvedValue(false);
      jobFind.mockResolvedValue(job({ status: "published", sheetUrl: STALE }));
      const res = await publishPOST(req(), params);
      expect(res.status).toBe(200);
      expect(jobUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sheetUrl: null }) }),
      );
      await expect(res.json()).resolves.toMatchObject({ sheetUrl: null });
    });

    it("user has no assigned folder", async () => {
      withDrive();
      folderFind.mockResolvedValue(null);
      jobFind.mockResolvedValue(job({ status: "published", sheetUrl: STALE }));
      const res = await publishPOST(req(), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sheetUrl).toBeNull();
      expect(body.exportNote).toMatch(/stale sheet link cleared/);
    });

    it("no xlsx artifact to export", async () => {
      withDrive();
      artifactFind.mockResolvedValue(null);
      jobFind.mockResolvedValue(job({ status: "published", sheetUrl: STALE }));
      const res = await publishPOST(req(), params);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ sheetUrl: null });
    });

    it("a skip with NO prior link stays null and notes the skip (unchanged)", async () => {
      driveConnected.mockResolvedValue(false);
      jobFind.mockResolvedValue(job()); // sheetUrl null
      const res = await publishPOST(req(), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sheetUrl).toBeNull();
      expect(body.exportNote).toBe("Drive not connected — sheet export skipped");
    });
  });

  it("first publish with no prior sheet creates one (unchanged behaviour)", async () => {
    withDrive();
    jobFind.mockResolvedValue(job());
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(assertFolder).not.toHaveBeenCalled();
    expect(updateSheet).not.toHaveBeenCalled();
    expect(createSheet).toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });
});
