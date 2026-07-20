import Link from "next/link";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { DRIVE_TOKEN_SCOPE } from "@/lib/driveAuth";
import { getSetting } from "@/lib/appSettings";
import { DEFAULT_SUMMARY_INSTRUCTIONS, getStoredSummaryInstructions } from "@/lib/summaryInstructions";
import { SettingEditor } from "@/components/admin/SettingEditor";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const AGENT = process.env.AGENTGLOB_AGENT_NAME ?? "onlyclaw";

export default async function AdminSettingsPage() {
  const admin = await requireAdmin();
  const saveToken = mintSaveToken(admin.email, DRIVE_TOKEN_SCOPE);

  const [chatPreamble, homePrompts, homeNote, reportRules, summaryStored, mappings] =
    await Promise.all([
      getSetting("chat_preamble"),
      getSetting("home_prompts"),
      getSetting("home_note"),
      getSetting("report_rules"),
      getStoredSummaryInstructions(),
      db.merchantMapping.findMany({
        where: { approved: true },
        select: { merchantPattern: true, category: true, source: true },
        orderBy: { merchantPattern: "asc" },
        take: 500,
      }),
    ]);

  return (
    <div className="mx-auto max-w-3xl pb-16">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Control how Plusim talks to users and how the {AGENT} agent behaves — from here, without the
        AgentGlob dashboard.
      </p>

      {/* Chat guidance */}
      <section className="mt-6 border-t pt-6">
        <h2 className="text-sm font-semibold">Chat guidance</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          Steering text prepended (invisibly) to the first message of every new chat — e.g. tone,
          language, what to focus on. Leave blank for none. It augments, never replaces, a user&apos;s
          own meeting-summary context.
        </p>
        <SettingEditor
          settingKey="chat_preamble"
          initial={chatPreamble ?? ""}
          saveToken={saveToken}
          placeholder="e.g. You are Plusim's financial guide. Be concise and practical; reply in Hebrew."
          heightClass="h-40"
        />
      </section>

      {/* Home prompts */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Home prompts</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          Clickable suggestion chips on the signed-in home hub — <strong>one prompt per line</strong>{" "}
          (first 5 shown). Blank hides the panel.
        </p>
        <SettingEditor
          settingKey="home_prompts"
          initial={homePrompts ?? ""}
          saveToken={saveToken}
          placeholder={"עזרה בתכנון תקציב חודשי\nאיך לחסוך על הוצאות קבועות?\nבדיקת דוח האשראי שלי"}
          heightClass="h-40"
        />
      </section>

      {/* Owner note */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Home owner note</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          A short markdown note shown at the top of the home hub (announcements, a welcome line).
          Blank hides it.
        </p>
        <SettingEditor
          settingKey="home_note"
          initial={homeNote ?? ""}
          saveToken={saveToken}
          placeholder="**ברוכים הבאים לפלוסים** — כאן תמצאו את הדוחות והליווי הפיננסי שלכם."
          heightClass="h-32"
        />
      </section>

      {/* Report categorization rules */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Report categorization rules</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          Free-text guidance the {AGENT} agent applies when it has to <strong>judge a merchant</strong>{" "}
          the built-in rules and the merchant dictionary couldn&apos;t place — sent in every job&apos;s
          manifest. It steers the model&apos;s judgment of <em>unresolved</em> merchants; it does{" "}
          <strong>not</strong> override a category the deterministic pass already assigned. For a hard
          &ldquo;this merchant always → that category&rdquo; rule, approve a{" "}
          <strong>merchant-dictionary</strong> mapping instead (below) — those are applied first and win.
          Blank ⇒ the built-in playbook only. Takes effect on the next report job.
        </p>
        <SettingEditor
          settingKey="report_rules"
          initial={reportRules ?? ""}
          saveToken={saveToken}
          placeholder={'e.g. "אם מופיע רק שם קניון ללא חנות → un_categorized" · "עסקאות מלונות/נופש → נופש וחופשות"'}
          heightClass="h-48"
        />
      </section>

      {/* Meeting summary method */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Meeting summary method</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          The method the agent applies when summarizing a meeting transcript from Drive. Leave blank
          to use the built-in default. The transcript and the output format (TITLE/DATE + Hebrew) are
          added automatically — just describe the method/structure here.
        </p>
        <SettingEditor
          settingKey="summary_instructions"
          initial={summaryStored ?? ""}
          defaultText={DEFAULT_SUMMARY_INSTRUCTIONS}
          saveToken={saveToken}
          heightClass="h-[50vh]"
        />
      </section>

      {/* Merchant dictionary (read-only) */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Merchant dictionary</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          The {mappings.length} approved merchant → category mapping{mappings.length === 1 ? "" : "s"}{" "}
          the deterministic categorizer applies before the agent judges anything. Add or approve
          mappings from a{" "}
          <Link href="/admin/reports" className="underline">
            report job&apos;s detail page
          </Link>
          .
        </p>
        {mappings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No approved mappings yet.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-xl border">
            <table className="w-full text-sm" dir="auto">
              <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Merchant pattern</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.merchantPattern} className="border-t">
                    <td className="px-3 py-1.5">{m.merchantPattern}</td>
                    <td className="px-3 py-1.5">{m.category}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{m.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Agent & skills (static note) */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Agent &amp; skills</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Plusim runs on the AgentGlob agent <code className="rounded bg-muted px-1">{AGENT}</code>.
          The agent&apos;s persona and its installed skill <em>files</em> (e.g. the statement-parsing
          skill) live on AgentGlob and are managed there — they can&apos;t be edited from this app.
          What you tune here are the levers Plusim sends the agent on every request: the chat
          guidance above, and the report categorization rules that ride along in each job.
        </p>
      </section>
    </div>
  );
}
