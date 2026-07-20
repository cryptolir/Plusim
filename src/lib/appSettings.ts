import { db } from "@/lib/db";

/**
 * Admin-editable app settings, stored as plaintext in the `AppSetting` key/value
 * table (the same store `summaryInstructions.ts` has always used). Managed from
 * `/admin/settings`.
 *
 * `SETTING_KEYS` is the **trust boundary** for the generic PUT route
 * (`/admin/api/settings/[key]`): a key not in this allowlist is never written,
 * so the route can never be steered into writing arbitrary `AppSetting` rows
 * (e.g. the encrypted `drive_oauth` token).
 */
export const SETTING_KEYS = [
  "summary_instructions", // meeting-summary method (has a built-in default)
  "chat_preamble", // first-message steering for onlyclaw chat
  "home_prompts", // home-hub clickable prompts (one per line)
  "home_note", // home-hub owner note (markdown)
  "report_rules", // extra statement-categorization rules, served in the job manifest
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

/** Raw stored value for a key, or null when unset/blank. Never throws. */
export async function getSetting(key: SettingKey): Promise<string | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key } });
    const v = row?.value?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Upsert a setting (value trimmed). */
export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const v = value.trim();
  await db.appSetting.upsert({
    where: { key },
    update: { value: v },
    create: { key, value: v },
  });
}
