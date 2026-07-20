/**
 * App half of Codex review P1: the job manifest carries the admin `report_rules`
 * setting as a `reportRules` field (the skill's run_job.py then surfaces it into
 * needs_judgment.json and SKILL.md tells the model to apply it). Blank ⇒ "".
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    statementFile: { findMany: vi.fn(async () => []) },
    merchantMapping: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/agentRuntimeAuth", () => ({
  authorizeAgentJobRequest: vi.fn(async () => ({ job: { status: "processing" } })),
  appBaseUrl: () => "https://plusim.xyz",
}));
vi.mock("@/lib/appSettings", () => ({ getSetting: vi.fn() }));

import { getSetting } from "@/lib/appSettings";
import { GET as manifestGET } from "./jobs/[jobId]/manifest/route";

const setting = getSetting as unknown as ReturnType<typeof vi.fn>;

async function manifest(): Promise<Record<string, unknown>> {
  const req = new NextRequest("https://plusim.xyz/api/agent/jobs/jobA/manifest?t=tok");
  const res = await manifestGET(req, { params: Promise.resolve({ jobId: "jobA" }) });
  return res.json();
}

beforeEach(() => vi.clearAllMocks());

it("includes the admin report_rules when set", async () => {
  setting.mockResolvedValue("כל עסקה מרמי לוי → מזון ומכולת");
  const body = await manifest();
  expect(body.reportRules).toBe("כל עסקה מרמי לוי → מזון ומכולת");
  expect(setting).toHaveBeenCalledWith("report_rules");
});

it("sends an empty string (never omits the field) when unset", async () => {
  setting.mockResolvedValue(null);
  const body = await manifest();
  expect(body.reportRules).toBe("");
});
