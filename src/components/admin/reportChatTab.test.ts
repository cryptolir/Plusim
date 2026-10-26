/**
 * The "שיחה עם הסוכן" tab (docs/plans/report-adjust-chat.md C1, C2), checked at
 * the source like the other admin view tests:
 *   - the tab comes right after "ללא סיווג", last in the row;
 *   - it talks to the job's admin chat route with the save token, and refreshes
 *     the page after each reply;
 *   - the home chat's request to /api/chat is unchanged when no options are
 *     passed (the runtime's new options are additive).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("ReportView tabs", () => {
  const src = read("src/components/admin/ReportView.tsx");
  it("tab order ends … ללא סיווג, שיחה עם הסוכן", () => {
    const block = /const TABS[^=]*=\s*\[([\s\S]*?)\];/.exec(src)![1];
    const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["ניתוח תוצאות", "התפלגות ההוצאות", "פירוט תנועות", "ללא סיווג", "שיחה עם הסוכן"]);
  });
  it("the agent tab renders the chat, outside the month filter", () => {
    expect(src).toMatch(/tab === "agent" \? \(\s*\/\/[^\n]*\n\s*<ReportChatTab jobId=\{job\.id\} saveToken=\{saveToken\} \/>/);
  });
});

describe("ReportChatTab", () => {
  const src = read("src/components/admin/ReportChatTab.tsx");
  it("posts to the job's admin chat route with the save token, and refreshes after a reply", () => {
    expect(src).toContain("const chatUrl = `/admin/api/reports/${jobId}/chat`;");
    expect(src).toContain('"x-admin-save-token": saveToken');
    expect(src).toContain("onReply: () => router.refresh()");
    expect(src).toContain("showSuggestions={false}");
    expect(src).toContain("גיליון Google יתעדכן בלחיצה על פרסום בעבודת הדוח");
  });
});

describe("home chat regression guard", () => {
  const src = read("src/lib/plusimRuntime.ts");
  it("defaults are exactly today's endpoints", () => {
    expect(src).toContain('const DEFAULT_CHAT_URL = "/api/chat";');
    expect(src).toContain("const defaultHistoryUrl = (cid: string) => `/api/chat/history?conversationId=${cid}`;");
  });
  it("the request body is unchanged and the headers only gain caller-provided ones", () => {
    expect(src).toContain('headers: { "content-type": "application/json", ...ep.headers },');
    expect(src).toMatch(
      /body: JSON\.stringify\(\{\s*conversationId: conversationIdRef\.current,\s*message: text,\s*sectionContext: sectionContextOverride \?\? sectionContextRef\.current,\s*\}\)/,
    );
    // Spreading undefined adds nothing: the home chat's headers are byte-identical.
    expect({ "content-type": "application/json", ...undefined }).toEqual({ "content-type": "application/json" });
  });
  it("the generic Hebrew errors stay the default", () => {
    expect(src).toContain("const serverError = ep.showServerErrors");
    expect(src).toContain('"משהו השתבש. נסו שוב."');
  });
  it("the home chat's callers pass none of the new options", () => {
    for (const f of ["src/components/home/HomeHub.tsx", "src/app/chat/page.tsx"]) {
      const caller = read(f);
      expect(caller).not.toMatch(/chatUrl|historyUrl|showServerErrors|onReply/);
    }
  });
});
