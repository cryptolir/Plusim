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
  "fixed" by adding/removing/adjusting rows to force agreement.

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
   utilities) — not one-off or ambiguous ones.
