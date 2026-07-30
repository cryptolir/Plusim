/**
 * Generic settings PUT route. Proves the auth gate fires first, the SETTING_KEYS
 * allowlist rejects unknown keys (400, nothing written), body validation, and a
 * valid write reaches setSetting. (Codex review ask #1 — the write surface.)
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/driveAuth", () => ({ authorizeDriveRequest: vi.fn() }));
vi.mock("@/lib/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/appSettings")>()),
  setSetting: vi.fn(),
}));

import { authorizeDriveRequest } from "@/lib/driveAuth";
import { setSetting } from "@/lib/appSettings";
import { PUT } from "./[key]/route";

const authz = authorizeDriveRequest as unknown as ReturnType<typeof vi.fn>;
const setMock = setSetting as unknown as ReturnType<typeof vi.fn>;

function put(key: string, body: unknown) {
  const req = new NextRequest(`https://plusim.xyz/admin/api/settings/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PUT(req, { params: Promise.resolve({ key }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  authz.mockResolvedValue(null); // authorized by default
});

it("denies when the auth gate rejects — before touching the body", async () => {
  authz.mockResolvedValue(NextResponse.json({ error: "נדרשת התחברות מחדש" }, { status: 401 }));
  const res = await put("chat_preamble", { value: "x" });
  expect(res.status).toBe(401);
  expect(setMock).not.toHaveBeenCalled();
});

it("rejects a key not on the allowlist → 400, nothing written", async () => {
  const res = await put("drive_oauth", { value: "malicious" });
  expect(res.status).toBe(400);
  expect(setMock).not.toHaveBeenCalled();
});

it("rejects a non-string value → 400", async () => {
  const res = await put("chat_preamble", { value: 123 });
  expect(res.status).toBe(400);
  expect(setMock).not.toHaveBeenCalled();
});

it("rejects an over-long value → 413", async () => {
  const res = await put("report_rules", { value: "x".repeat(20_001) });
  expect(res.status).toBe(413);
  expect(setMock).not.toHaveBeenCalled();
});

it("writes a valid key+value → 200", async () => {
  const res = await put("home_prompts", { value: "one\ntwo" });
  expect(res.status).toBe(200);
  expect(setMock).toHaveBeenCalledWith("home_prompts", "one\ntwo");
});
