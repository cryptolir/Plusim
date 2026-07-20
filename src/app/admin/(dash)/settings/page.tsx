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
      <h1 className="text-xl font-semibold">הגדרות</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        שלטו כאן באופן שבו Plusim מדבר עם המשתמשים ובאופן שבו סוכן ה-{AGENT} מתנהג — בלי צורך
        בדשבורד AgentGlob.
      </p>

      {/* Chat guidance */}
      <section className="mt-6 border-t pt-6">
        <h2 className="text-sm font-semibold">הנחיות לשיחה</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          טקסט הכוונה שמתווסף (באופן בלתי נראה) בתחילת ההודעה הראשונה בכל שיחה חדשה — למשל טון,
          שפה, במה להתמקד. השאירו ריק אם אין צורך. הטקסט מוסיף להקשר סיכומי הפגישות של המשתמש
          ולעולם לא מחליף אותו.
        </p>
        <SettingEditor
          settingKey="chat_preamble"
          initial={chatPreamble ?? ""}
          saveToken={saveToken}
          placeholder="לדוגמה: אתה המדריך הפיננסי של Plusim. היה תמציתי ומעשי; השב בעברית."
          heightClass="h-40"
        />
      </section>

      {/* Home prompts */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">הצעות לעמוד הבית</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          תגיות הצעה ללחיצה בעמוד הבית של משתמשים מחוברים — <strong>שורה אחת לכל הצעה</strong>{" "}
          (מוצגות עד 5 הראשונות). השאירו ריק כדי להסתיר את הפאנל.
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
        <h2 className="text-sm font-semibold">הערת מנהל לעמוד הבית</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          הערת markdown קצרה שמוצגת בראש עמוד הבית (הודעות, שורת ברוכים הבאים). השאירו ריק כדי
          להסתיר אותה.
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
        <h2 className="text-sm font-semibold">כללי סיווג דוחות</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          הנחיה חופשית שסוכן {AGENT} מיישם כשהוא צריך <strong>לשפוט בית עסק</strong> שהכללים
          המובנים ומילון בתי העסק לא הצליחו לשבץ — נשלחת במניפסט של כל עבודה. ההנחיה מכוונת את
          שיקול הדעת של המודל לגבי בתי עסק <em>לא פתורים</em>; היא <strong>לא</strong> דורסת קטגוריה
          שכבר הוקצתה על ידי המעבר הדטרמיניסטי. לכלל נוקשה מסוג &ldquo;בית עסק כזה תמיד → קטגוריה
          כזו&rdquo;, אשרו במקום זאת מיפוי ב<strong>מילון בתי העסק</strong> (למטה) — מיפויים כאלה
          מוחלים ראשונים וגוברים. ריק ⇒ רק ספר הפעולות המובנה. נכנס לתוקף בעבודת הדוח הבאה.
        </p>
        <SettingEditor
          settingKey="report_rules"
          initial={reportRules ?? ""}
          saveToken={saveToken}
          placeholder={'לדוגמה: "אם מופיע רק שם קניון ללא חנות → un_categorized" · "עסקאות מלונות/נופש → נופש וחופשות"'}
          heightClass="h-48"
        />
      </section>

      {/* Meeting summary method */}
      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">שיטת סיכום הפגישות</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          השיטה שהסוכן מיישם כשהוא מסכם תמלול פגישה מ-Drive. השאירו ריק כדי להשתמש בברירת המחדל
          המובנית. התמלול ופורמט הפלט (TITLE/DATE + עברית) מתווספים אוטומטית — תארו כאן רק את
          השיטה/המבנה.
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
        <h2 className="text-sm font-semibold">מילון בתי עסק</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          {mappings.length}{" "}
          {mappings.length === 1 ? "מיפוי בית עסק → קטגוריה מאושר" : "מיפויי בית עסק → קטגוריה מאושרים"}{" "}
          שהמסווג הדטרמיניסטי מיישם לפני שהסוכן שופט דבר. הוסיפו או אשרו מיפויים דרך{" "}
          <Link href="/admin/reports" className="underline">
            עמוד הפרטים של עבודת דוח
          </Link>
          .
        </p>
        {mappings.length === 0 ? (
          <p className="text-sm text-muted-foreground">אין עדיין מיפויים מאושרים.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-xl border">
            <table className="w-full text-sm" dir="auto">
              <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">תבנית בית עסק</th>
                  <th className="px-3 py-2 font-medium">קטגוריה</th>
                  <th className="px-3 py-2 font-medium">מקור</th>
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
        <h2 className="text-sm font-semibold">הסוכן וה-skills</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Plusim פועל על גבי סוכן ה-AgentGlob בשם <code className="rounded bg-muted px-1">{AGENT}</code>.
          אישיות הסוכן וקובצי ה-<em>skill</em> המותקנים שלו (למשל ה-skill לפענוח דפי חשבון) מנוהלים
          ב-AgentGlob — אי אפשר לערוך אותם מהאפליקציה הזו. מה שכן ניתן לכוונן כאן הם הפרמטרים
          ש-Plusim שולח לסוכן בכל בקשה: הנחיות השיחה שלמעלה, וכללי סיווג הדוחות שנשלחים עם כל עבודה.
        </p>
      </section>
    </div>
  );
}
