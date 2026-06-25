import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { authorizeDriveRequest } from "@/lib/driveAuth";
import { getSummaryInstructions } from "@/lib/summaryInstructions";
import {
  assertEntryUnderRoot,
  getFileText,
  listSummaries,
  DriveNotConnectedError,
  DriveOutsideRootError,
  UnsupportedTranscriptTypeError,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_TRANSCRIPT_CHARS = 100_000; // gpt-4.1-mini has a large (1M) context window
const SUMMARY_TIMEOUT_MS = 90_000;
// Summarization is a direct OpenAI call (NOT through the agent) — the agent
// runtime was too slow/flaky for large transcripts. Needs OPENAI_API_KEY in env.
const SUMMARY_MODEL = "gpt-4.1-mini";

// Tolerant of the agent leading with noise (e.g. a sub-agent warning) and of
// "TITLE  " / "DATE 2026-06-15" (missing colon, empty value): scan the first
// lines for TITLE/DATE anywhere, take the body after the last meta line.
function parseTitleDate(reply: string): { title?: string; date?: string; body: string } {
  const lines = reply.split("\n");
  let title: string | undefined;
  let date: string | undefined;
  let lastMeta = -1;
  for (let i = 0; i < lines.length && i < 15; i++) {
    const t = lines[i].trim();
    const mt = t.match(/^TITLE\s*[:\-]?\s*(.*)$/i);
    const md = t.match(/^DATE\s*[:\-]?\s*(.*)$/i);
    if (mt) {
      if (mt[1].trim()) title = mt[1].trim();
      lastMeta = i;
      continue;
    }
    if (md) {
      if (md[1].trim()) date = md[1].trim();
      lastMeta = i;
      continue;
    }
  }
  const body = lastMeta >= 0 ? lines.slice(lastMeta + 1).join("\n").trim() : reply.trim();
  return { title, date, body: body || reply.trim() };
}

function isoDate(s: string | undefined, fallbackIso: string): string {
  if (s) {
    const m = s.match(/\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
  }
  return fallbackIso.slice(0, 10);
}

// Generates a summary with the agent and RETURNS it for admin review.
// Saving to Drive is a separate, explicit step (POST /admin/api/drive/save-summary).
export async function POST(req: NextRequest) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  let body: { fileId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.fileId !== "string" || !body.fileId) {
    return NextResponse.json({ error: "missing fileId" }, { status: 400 });
  }
  const fileId = body.fileId;

  try {
    const entry = await assertEntryUnderRoot(fileId); // rejects files outside the root tree
    if (entry.isFolder) return NextResponse.json({ error: "selected item is a folder" }, { status: 400 });
    const parentFolderId = entry.parents?.[0];
    if (!parentFolderId) return NextResponse.json({ error: "file has no parent folder" }, { status: 400 });

    // Informational only — does a summary for this source already exist?
    const existing = (await listSummaries(parentFolderId)).find(
      (s) => s.appProperties?.sourceFileId === fileId,
    );

    let text = await getFileText(entry);
    let truncated = false;
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      const original = text.length;
      text = text.slice(0, MAX_TRANSCRIPT_CHARS) + `\n\n[…truncated: original ${original} chars]`;
      truncated = true;
      console.warn(`[drive/summarize] transcript ${fileId} truncated ${original}→${MAX_TRANSCRIPT_CHARS} chars`);
    }

    const method = await getSummaryInstructions(); // admin-editable, defaults to the TAL method
    const system =
      "You summarize meeting transcripts by applying the provided method exactly. " +
      "Output ONLY two header lines then the summary, with no preamble: " +
      "a 'TITLE: <short descriptive title>' line, then a 'DATE: <YYYY-MM-DD if derivable from the " +
      "transcript, else blank>' line, then the summary itself written in Hebrew.";
    const userPrompt = `=== METHOD ===\n${method}\n\n=== TRANSCRIPT ===\n${text}`;

    console.log(
      `[drive/summarize] fileId=${fileId} model=${SUMMARY_MODEL} methodChars=${method.length} transcriptChars=${text.length}`,
    );

    // Direct OpenAI call (no agent runtime) — fast + reliable at any size.
    let reply = "";
    try {
      const result = await generateText({
        model: openai(SUMMARY_MODEL),
        system,
        prompt: userPrompt,
        abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
      reply = result.text ?? "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[drive/summarize] OpenAI call failed:", msg);
      const friendly = /api key|OPENAI_API_KEY|401|unauthor/i.test(msg)
        ? "OpenAI key missing or invalid — set OPENAI_API_KEY in the app config."
        : "Summarization failed. Please try again in a moment.";
      return NextResponse.json({ error: friendly }, { status: 502 });
    }
    console.log(
      `[drive/summarize] fileId=${fileId} replyChars=${reply.length} head=${JSON.stringify(reply.slice(0, 100))}`,
    );
    if (!reply.trim()) {
      return NextResponse.json({ error: "The model returned an empty summary. Please try again." }, { status: 502 });
    }

    const parsed = parseTitleDate(reply);
    const sourceBase = entry.name.replace(/\.[^.]+$/, "");
    const title = (parsed.title || sourceBase).slice(0, 120);
    const date = isoDate(parsed.date, entry.createdTime || new Date().toISOString());

    return NextResponse.json({
      ok: true,
      fileId,
      sourceName: entry.name,
      title,
      date,
      summary: parsed.body,
      truncated,
      alreadyExists: existing ? { id: existing.id, name: existing.name } : null,
    });
  } catch (e) {
    if (e instanceof DriveNotConnectedError) return NextResponse.json({ error: "not connected" }, { status: 409 });
    if (e instanceof DriveOutsideRootError) return NextResponse.json({ error: "file outside root" }, { status: 403 });
    if (e instanceof UnsupportedTranscriptTypeError)
      return NextResponse.json({ error: "unsupported file type" }, { status: 415 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
