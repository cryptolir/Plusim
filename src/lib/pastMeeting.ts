import { db } from "@/lib/db";
import { getFileText, isDriveConnected, listSummaries } from "@/lib/googleDrive";

const MAX_SUMMARY_CHARS = 8_000;

/**
 * Background context for a user who has a linked Drive folder with meeting
 * summaries: a list of meetings on file + the full text of the most recent
 * summary. Injected (invisibly) on the first turn of the user's conversations
 * so the agent has more context than the workspace files alone. Returns null
 * when there's no linked folder / no summaries. Never throws (Drive outage → null).
 *
 * Phase B1 — bounded. Pass `timeoutMs` and the whole build (incl. the OAuth
 * refresh inside `isDriveConnected`/`listSummaries`) is capped by an outer
 * `Promise.race` deadline: on expiry it returns null so the send proceeds
 * without context instead of waiting. An `AbortSignal` tied to that deadline is
 * threaded into the Drive fetches so an in-flight list/export is cancelled too
 * (cleanup — the outer race is the actual time bound). `onTimedOut` fires only
 * on the deadline path so the caller can log `contextTimedOut`.
 */
export async function buildLinkedFolderContext(
  userId: string,
  opts?: { timeoutMs?: number; onTimedOut?: () => void },
): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs;
  if (!timeoutMs) return buildFolderContext(userId);

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    // buildFolderContext never throws (catches → null), so the race never rejects.
    return await Promise.race([buildFolderContext(userId, controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) opts?.onTimedOut?.();
  }
}

async function buildFolderContext(userId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const folder = await db.userDriveFolder.findUnique({ where: { userId } });
    if (!folder || !(await isDriveConnected())) return null;
    const summaries = await listSummaries(folder.folderId, signal);
    if (summaries.length === 0) return null;

    const latest = summaries[0]; // listSummaries is ordered createdTime desc
    let latestText = await getFileText(latest, signal);
    if (latestText.length > MAX_SUMMARY_CHARS) latestText = latestText.slice(0, MAX_SUMMARY_CHARS);

    const list = summaries
      .slice(0, 12)
      .map((s) => `- ${`${s.appProperties?.meetingDate ?? ""} ${s.appProperties?.meetingTitle ?? s.name}`.trim()}`)
      .join("\n");

    const latestMeta = `${latest.appProperties?.meetingDate ?? ""} ${latest.appProperties?.meetingTitle ?? ""}`.trim();
    return (
      "This user has summaries of past financial-planning meetings on file. Use them as background " +
      "context — do not quote them verbatim or state that they were provided to you; reply in Hebrew.\n\n" +
      `MEETINGS ON FILE:\n${list}\n\n` +
      `MOST RECENT MEETING SUMMARY${latestMeta ? ` (${latestMeta})` : ""}:\n${latestText}`
    );
  } catch {
    return null;
  }
}
