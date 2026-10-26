/**
 * The client download never serves a workbook older than the rows' latest
 * chat edits (docs/plans/report-adjust-chat.md B7a).
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findFirst: vi.fn() },
    reportArtifact: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/reportWorkbook", () => ({ ensureFreshWorkbook: vi.fn() }));

import { db } from "@/lib/db";
import { ensureFreshWorkbook } from "@/lib/reportWorkbook";
import { GET } from "./[jobId]/download/route";

const jobFind = db.reportJob.findFirst as unknown as ReturnType<typeof vi.fn>;
const artifactFind = db.reportArtifact.findFirst as unknown as ReturnType<typeof vi.fn>;
const ensureFresh = ensureFreshWorkbook as unknown as ReturnType<typeof vi.fn>;
const call = () => GET(new NextRequest("https://plusim.xyz/api/reports/jobA/download"), { params: Promise.resolve({ jobId: "jobA" }) });

beforeEach(() => {
  vi.clearAllMocks();
  jobFind.mockResolvedValue({ id: "jobA" });
  artifactFind.mockResolvedValue({ filename: "r.xlsx", bytes: Buffer.from("PK-x") });
});

it("a fresh (or freshly rebuilt) workbook is served", async () => {
  ensureFresh.mockResolvedValue(true);
  const res = await call();
  expect(res.status).toBe(200);
  expect(ensureFresh).toHaveBeenCalledWith("jobA");
});

it("stale and unbuildable ⇒ 503 (Hebrew), the old bytes are not served", async () => {
  ensureFresh.mockResolvedValue(false);
  const res = await call();
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe("הדוח מתעדכן — נסו שוב בעוד רגע");
  expect(artifactFind).not.toHaveBeenCalled();
});

it("someone else's job is a 404 before any rebuild", async () => {
  jobFind.mockResolvedValue(null);
  expect((await call()).status).toBe(404);
  expect(ensureFresh).not.toHaveBeenCalled();
});
