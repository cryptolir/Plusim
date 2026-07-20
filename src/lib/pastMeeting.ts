import { db } from "@/lib/db";
import { getFileText, isDriveConnected, listSummaries } from "@/lib/googleDrive";

const MAX_SUMMARY_CHARS = 8_000;

/**
 * Background context for a user who has a linked Drive folder with meeting
 * summaries: a list of meetings on file + the full text of the most recent
 * summary. Injected (invisibly) on the first turn of the user's conversations
 * so the agent has more context than the workspace files alone. Returns null
 * when there's no linked folder / no summaries. Never throws (Drive outage → null).
 */
export async function buildLinkedFolderContext(userId: string): Promise<string | null> {
  try {
    const folder = await db.userDriveFolder.findUnique({ where: { userId } });
    if (!folder || !(await isDriveConnected())) return null;
    const summaries = await listSummaries(folder.folderId);
    if (summaries.length === 0) return null;

    const latest = summaries[0]; // listSummaries is ordered createdTime desc
    let latestText = await getFileText(latest);
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
