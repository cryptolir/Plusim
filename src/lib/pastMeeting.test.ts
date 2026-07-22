/**
 * T5 — the bounded first-turn Drive context build. On a slow/hanging Drive the
 * outer deadline returns null (send proceeds context-less) and fires onTimedOut
 * so the route can log `contextTimedOut`; a non-timeout Drive error still
 * resolves to null (never-throws contract) WITHOUT flagging a timeout; a build
 * that finishes in time returns the context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { userDriveFolder: { findUnique: vi.fn(async () => ({ userId: "u", folderId: "f" })) } },
}));
vi.mock("@/lib/googleDrive", () => ({
  isDriveConnected: vi.fn(async () => true),
  listSummaries: vi.fn(),
  getFileText: vi.fn(),
}));

import { buildLinkedFolderContext } from "./pastMeeting";
import { listSummaries, getFileText } from "@/lib/googleDrive";

const list = listSummaries as unknown as ReturnType<typeof vi.fn>;
const text = getFileText as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

it("hanging Drive → null within the deadline + onTimedOut fires (T5)", async () => {
  // Hang until the deadline's AbortSignal fires, then reject like a real fetch.
  list.mockImplementation(
    (_id: string, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  let timedOut = false;
  const res = await buildLinkedFolderContext("u", {
    timeoutMs: 20,
    onTimedOut: () => {
      timedOut = true;
    },
  });
  expect(res).toBeNull();
  expect(timedOut).toBe(true);
});

it("non-timeout Drive error → null, onTimedOut NOT fired (T5)", async () => {
  list.mockRejectedValue(new Error("drive 500"));
  let timedOut = false;
  const res = await buildLinkedFolderContext("u", {
    timeoutMs: 5000,
    onTimedOut: () => {
      timedOut = true;
    },
  });
  expect(res).toBeNull();
  expect(timedOut).toBe(false);
});

it("success within the deadline → built context (T5)", async () => {
  list.mockResolvedValue([
    {
      id: "s1",
      name: "sum",
      mimeType: "text/plain",
      isFolder: false,
      createdTime: "",
      modifiedTime: "",
      appProperties: { meetingDate: "2026-01-01", meetingTitle: "Kickoff" },
    },
  ]);
  text.mockResolvedValue("SUMMARY BODY");
  const res = await buildLinkedFolderContext("u", { timeoutMs: 5000 });
  expect(res).toContain("SUMMARY BODY");
  expect(res).toContain("MEETINGS ON FILE");
});
