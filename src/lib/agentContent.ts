// Parse the agent-workspace prompts file (User_D_Prompt.md) into clickable prompts.
// Convention: one prompt per non-empty line. List markers / numbering / headings /
// blockquote markers are stripped. Horizontal rules and bare headings are skipped.
export function parsePrompts(
  md: string | null | undefined,
  limit = 5,
): string[] {
  if (!md) return [];
  const prompts: string[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^-{3,}$/.test(line)) continue; // horizontal rule
    const cleaned = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^>\s+/, "")
      .trim();
    if (!cleaned) continue;
    prompts.push(cleaned);
    if (prompts.length >= limit) break;
  }
  return prompts;
}

/**
 * Extract the `name:` value from an app_profile section body (the column-0
 * `name: <value>` line). Returns null when absent/blank. Local one-field parse
 * equivalent to the dashboard's parseAppProfile().name; avoids importing
 * dashboard code.
 */
export function parseAppProfileName(section: string | null | undefined): string | null {
  if (!section) return null;
  const m = /^name:[ \t]*(\S.*)$/m.exec(section);
  const v = m?.[1]?.trim();
  return v ? v : null;
}
