# Categorization playbook

Proven against real Isracard/Leumi + MAX statements (reconciled to the agora).
The deterministic parts are implemented in `../scripts/run_job.py` (RULES,
MAX_CATEGORY_MAP); this document governs the **judgment step** and records the
invariants the scripts enforce.

## Invariants (enforced by code — never override)

- **Month** = the calendar month of the *transaction* date (`תאריך רכישה`),
  never the billing month. A June purchase billed on 10.07 belongs to June.
- **Amount** = the actual charge (`סכום חיוב`, after discounts and per
  installment), in agorot integers. Credits/cancellations (`ביטול עסקה`,
  `זיכוי`) keep their negative sign. Installments (`תשלום X מתוך Y`) count the
  installment charge only, not the full purchase.
- **Dedup**: pending rows (`עסקאות שטרם נקלטו`) that reappear among billed rows
  of the same statement are dropped; voucher-distinct rows are never merged;
  identical same-day rows (two ₪15 vending charges) are distinct transactions.
- **Reconciliation**: per source, sum(rows) must equal the statement's own
  printed total exactly. A mismatch is reported as `needs_review` — never
  "fixed" by adding/removing/adjusting rows to force agreement. A bank
  current-account export prints no total: its completeness is the intact
  running-balance chain (a break is a warning naming the row).
- **Settlements** (bank statements): a bank *debit* whose payee is a card
  issuer (`SETTLEMENT_PAYEES` in `../scripts/bank_rows.py`, matched on whole
  tokens, observed strings only) pays a card statement that is itemized on its
  own. It is never a transaction — not an expense, not in any total — and is
  reported in `settlements` for the client's reconciliation card. An issuer
  *credit* is NOT a settlement: it stays a transaction (a card refund landing
  in the account) and is judged like any other credit.
- **Kind** (bank statements): a categorized row has `kind = income` exactly when
  its leaf is in the `הכנסות` section; such a row is a negative amount from a
  bank source. A credit placed in an expense leaf is a refund (`kind =
  expense`, a negative in that leaf — exactly a card refund). The sign never
  decides on its own: income and refunds are both negative.

## Judgment rules (the model step)

1. **Use the taxonomy leaves exactly** as spelled in the manifest. One leaf per
   transaction.
2. **Never guess.** If the merchant cannot be confidently identified, mark
   `uncategorized` with a short reason. Known ambiguous cases:
   - Mall-name-only descriptors (e.g. `ביג גדרה` alone) — unless the statement
     itself printed a category (MAX column), which may be trusted.
   - Prepaid wallet top-ups (`ארנק נטען`) — contents unknown.
   - Consumer-club charges with unknown items (`הוט מועדון צרכנות`).
   - A charge fully reversed by cancellations stays with its cancellations in
     un_categorized (net ₪0 — visible, not silently dropped).
3. **Common routings** (already in RULES, listed for context): BIT transfers →
   ביט · NETFLIX → נטפליקס · foreign sites (Apple/Etsy/`אתר חו"ל`) → רכישות
   באתרי חו"ל · fuel stations → דלק · supermarkets/vending → מזון ומכולת ·
   pharmacies/clinics → הוצאות ריפוי · card fees → עמלות+ריביות · local
   council (`ועד מקומי`) → ועד בית · toll roads/parking/licensing → אחזקת רכב
   ותיקונים · gyms → חוגי מבוגרים.
4. **Insurance carriers** route by line of business: mandatory/comprehensive
   car policies → רכב(חובה+מקיף); supplementary-health charges (`שרותי
   בריאות`) → בריאות משלים; generic carrier standing orders (e.g. מנורה
   מבטחים) → פרטי unless evidence says otherwise.
5. **MAX's printed category** may be trusted directly for: קוסמטיקה וטיפוח,
   אופנה, מסעדות/קפה, רפואה ובתי מרקחת, מזון ומשקאות (already auto-mapped).
   Its שונות / ביטוח / פנאי / העברת כספים labels are too broad — judge those
   yourself.
6. **propose: true** only for stable, recurring merchants (restaurants, clubs,
   utilities) — not one-off or ambiguous ones. Credit entries are never
   proposed (the dictionary is one direction per merchant).
7. **Credits** (bank statements; shortlist entries with `kind: "credit"`, key
   `<merchant>␟credit`). Money came IN. Decide which of two things it is:
   - **Income** → a leaf of the `הכנסות` section: salary (`משכורת 1` /
     `משכורת 2` — which payer is "1" is your call unless `reportRules` pins
     it), `קצבת ילדים`, `הכנסות נוספות` for treasury/tax/national-insurance
     refunds and incoming transfers that are income. The income rules already
     place `קצבת ילדים`, `ביטוח לאומי`/`בטוח לאומי`, `זיכוי מאוצה"ח`,
     `מס-הכנסה החז`.
   - **Refund** → the matching expense leaf with `"refund": true`: a
     reimbursement of a known expense (`שירותי בריאות` → `בריאות משלים`, an
     issuer credit → the leaf it refunds, a loan over-payment return →
     `הלוואות`).
   - Never guess between the two → `uncategorized` with a reason. An incoming
     transfer from a person or an unknown bank with no context is
     uncategorized, not income.
