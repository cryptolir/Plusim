import { db } from "@/lib/db";

export const SUMMARY_INSTRUCTIONS_KEY = "summary_instructions";

// Default summary method (the TAL meeting-summary skill, inlined). Used when the
// admin hasn't set custom instructions. Editable at /admin/settings, stored in
// the AppSetting table (plaintext). Keep roughly in sync with the agent's
// workspace/skills/tal-meeting-summary/SKILL.md if that's the source of truth.
export const DEFAULT_SUMMARY_INSTRUCTIONS = `Summarize meeting transcripts through the TAL methodology lens: bringing the Desired (רצוי) into the Present (מצוי). Extract the human layer — patterns, identity shifts, tensions, next steps — alongside the operational content.

Produce the summary in EXACTLY this structure:
### 1. מצוי — המצב הקיים
- The current situation; feelings/frustrations/tensions that surfaced; visible patterns or automatic reactions.
### 2. רצוי — המצב הרצוי
- What the participants want to be different; the identity/quality they're trying to build; what success looks like from their perspective.
### 3. דפוסים שזוהו
- For each pattern (1–3 max, only ones that clearly surfaced): Trigger → Interpretation → Emotion → Action → Result → Story Reinforcement (טריגר → פרשנות → רגש → תגובה → תוצאה → חיזוק הסיפור).
### 4. החלטות ופעולות
- Decisions made (who/what); action items with owners/deadlines if mentioned; open questions.
### 5. הזהות הנבחרת
- The identity shift/aspiration that emerged; how it connects to their goals; one quality to bring forward.
### 6. צעד קטן
- One concrete small action that bridges מצוי and רצוי, framed as a choice, doable within 24–48 hours.

Rules: use the full transcript; separate facts from interpretations; use the participants' own words for feelings/goals (quote briefly where impactful); do not diagnose or label people; do not lecture; ~300–600 words. Tone: clear, warm, non-judgmental, practical. Use TAL language (מצוי, רצוי, דפוס, זהות נבחרת, בחירה, תנועה).`;

/** Admin-edited summary instructions, or the default when unset/blank. Never throws. */
export async function getSummaryInstructions(): Promise<string> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SUMMARY_INSTRUCTIONS_KEY } });
    const v = row?.value?.trim();
    return v && v.length > 0 ? v : DEFAULT_SUMMARY_INSTRUCTIONS;
  } catch {
    return DEFAULT_SUMMARY_INSTRUCTIONS;
  }
}

/** Raw stored value (may be null when never set) — for the editor to show empty vs custom. */
export async function getStoredSummaryInstructions(): Promise<string | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SUMMARY_INSTRUCTIONS_KEY } });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSummaryInstructions(text: string): Promise<void> {
  const value = text.trim();
  await db.appSetting.upsert({
    where: { key: SUMMARY_INSTRUCTIONS_KEY },
    update: { value },
    create: { key: SUMMARY_INSTRUCTIONS_KEY, value },
  });
}
