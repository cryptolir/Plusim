import { getSetting, setSetting } from "@/lib/appSettings";

export const SUMMARY_INSTRUCTIONS_KEY = "summary_instructions";

// Default summary method for financial-planning meetings. Used when the admin
// hasn't set custom instructions. Editable at /admin/settings, stored in the
// AppSetting table (plaintext).
export const DEFAULT_SUMMARY_INSTRUCTIONS = `Summarize financial-planning meeting transcripts: capture the client's financial picture, the decisions made, and the concrete next steps. Separate facts from interpretation, and use the participants' own words for goals and concerns.

Produce the summary in EXACTLY this structure:
### 1. תמונת מצב פיננסית
- The client's current financial situation as it surfaced: income, expenses, debts, savings, obligations, and any figures mentioned. Facts only — never invent a number; if a figure wasn't stated, say so.
### 2. מטרות ואילוצים
- What the client wants to achieve (short- and long-term goals) and the constraints/concerns raised (risk tolerance, timeline, family needs). Quote briefly where impactful.
### 3. החלטות ופעולות
- Decisions made in the meeting; action items with owners and deadlines when mentioned (client vs. advisor); what was agreed to change.
### 4. סיכונים ושאלות פתוחות
- Risks, blind spots, or unresolved questions; anything that needs more data or a follow-up.
### 5. צעד הבא
- One concrete next step the client can take within the coming week, framed clearly and actionably.

Rules: use the full transcript; separate facts from interpretations; never invent figures; do NOT give regulated investment advice or recommend specific securities; ~300–600 words. Tone: clear, practical, respectful, non-judgmental. Output in Hebrew.`;

// Thin wrappers over the generic appSettings store (same "summary_instructions"
// key), preserving this module's public API + the built-in default.

/** Admin-edited summary instructions, or the default when unset/blank. Never throws. */
export async function getSummaryInstructions(): Promise<string> {
  return (await getSetting(SUMMARY_INSTRUCTIONS_KEY)) ?? DEFAULT_SUMMARY_INSTRUCTIONS;
}

/** Raw stored value (null when never set / blank) — for the editor to show empty vs custom. */
export async function getStoredSummaryInstructions(): Promise<string | null> {
  return getSetting(SUMMARY_INSTRUCTIONS_KEY);
}

export async function setSummaryInstructions(text: string): Promise<void> {
  return setSetting(SUMMARY_INSTRUCTIONS_KEY, text);
}
