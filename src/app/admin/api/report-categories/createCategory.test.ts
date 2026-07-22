/**
 * Create-category endpoint: fail closed on bad name/section, refuse base-leaf
 * shadows and duplicates (409), normalize + bound the Hebrew name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { reportCategory: { findUnique: vi.fn(), create: vi.fn() } },
}));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { POST as createPOST } from "./route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const find = db.reportCategory.findUnique as unknown as ReturnType<typeof vi.fn>;
const create = db.reportCategory.create as unknown as ReturnType<typeof vi.fn>;

function req(body: unknown) {
  return new NextRequest("https://plusim.xyz/admin/api/report-categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  find.mockResolvedValue(null);
  create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "cat1",
    name: data.name,
    section: data.section,
  }));
});

describe("POST /admin/api/report-categories", () => {
  it("creates a valid Hebrew category in a base section", async () => {
    const res = await createPOST(req({ name: "קטגוריה חדשה", section: "שונות" }));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "קטגוריה חדשה", section: "שונות", createdBy: "admin@plusim.xyz" },
      }),
    );
  });

  it("rejects a base-leaf shadow with 409 (test_create_category_rejects_base_leaf_collision)", async () => {
    const res = await createPOST(req({ name: "ביט", section: "שונות" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("קטגוריה כבר קיימת");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unknown section with 400 (test_create_category_rejects_unknown_section)", async () => {
    const res = await createPOST(req({ name: "קטגוריה חדשה", section: "מדור מומצא" }));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate DB row with 409 (test_create_category_rejects_duplicate)", async () => {
    find.mockResolvedValue({ id: "cat0", name: "קטגוריה חדשה", section: "שונות" });
    const res = await createPOST(req({ name: "קטגוריה חדשה", section: "שונות" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("קטגוריה כבר קיימת");
    expect(create).not.toHaveBeenCalled();
  });

  it("trims/normalizes the name and bounds its length (test_create_category_trims_and_bounds_name)", async () => {
    const res = await createPOST(req({ name: "  קטגוריה   חדשה  ", section: "שונות" }));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "קטגוריה חדשה" }) }),
    );

    for (const bad of ["", "   ", "א".repeat(61), 42, null]) {
      vi.clearAllMocks();
      auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
      const r = await createPOST(req({ name: bad, section: "שונות" }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("שם קטגוריה לא תקין");
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("non-object JSON body (null/array/scalar) → 400 bad shape, never a 500 (Codex round-1 P2)", async () => {
    for (const rawBody of ["null", "[]", '"סתם מחרוזת"', "42"]) {
      vi.clearAllMocks();
      auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
      const res = await createPOST(
        new NextRequest("https://plusim.xyz/admin/api/report-categories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("שם קטגוריה לא תקין");
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("duplicate-create race: unique-violation (P2002) from create → 409, same contract (Codex round-1 P3)", async () => {
    find.mockResolvedValue(null); // pre-check passes for both racers
    create.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await createPOST(req({ name: "קטגוריה חדשה", section: "שונות" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("קטגוריה כבר קיימת");
  });

  it("a non-P2002 create failure still surfaces as an error (not silently 409)", async () => {
    find.mockResolvedValue(null);
    create.mockRejectedValue(new Error("db down"));
    await expect(createPOST(req({ name: "קטגוריה חדשה", section: "שונות" }))).rejects.toThrow("db down");
  });
});
