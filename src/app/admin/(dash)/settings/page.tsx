import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { DRIVE_TOKEN_SCOPE } from "@/lib/driveAuth";
import { DEFAULT_SUMMARY_INSTRUCTIONS, getStoredSummaryInstructions } from "@/lib/summaryInstructions";
import { SummaryInstructionsEditor } from "@/components/admin/SummaryInstructionsEditor";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const admin = await requireAdmin();
  const stored = await getStoredSummaryInstructions();
  const saveToken = mintSaveToken(admin.email, DRIVE_TOKEN_SCOPE);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="mt-5">
        <h2 className="text-sm font-semibold">Summary instructions</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          The method the agent applies when summarizing a transcript. Leave blank to use the
          built-in default (the TAL method). The transcript and the output format (TITLE/DATE +
          Hebrew) are added automatically — just describe the method/structure here.
        </p>
        <SummaryInstructionsEditor
          initial={stored ?? ""}
          defaultText={DEFAULT_SUMMARY_INSTRUCTIONS}
          usingDefault={!stored || !stored.trim()}
          saveToken={saveToken}
        />
      </section>
    </div>
  );
}
