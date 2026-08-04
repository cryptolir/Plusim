/**
 * installmentInfo — the badge detector.
 *
 * Reads the installment marker out of the free-text `note` the card parsers
 * already write, so no column and no stored field. It must agree with
 * INSTALLMENT_RE in agent/skills/plusim-reports/scripts/parse_leumi_pdf.py: the
 * parser uses its match to decide which rows get re-dated, so a disagreement
 * shows up as a re-dated row with no badge (or a badge on a row still holding
 * its deal date).
 */
import { describe, it, expect } from "vitest";
import { installmentInfo } from "./reportAnalysis";

describe("installmentInfo", () => {
  // Exactly the wordings observed on the real statement (job דיין 9).
  it("parses both real wordings, including the RTL-reordered credit form", () => {
    expect(installmentInfo("תשלום 8 מתוך 12")).toEqual({ n: 8, of: 12 });
    expect(installmentInfo("תשלום - קרדיט 6 מתוך 13")).toEqual({ n: 6, of: 13 });
    expect(installmentInfo("תשלום 2 מתוך 2")).toEqual({ n: 2, of: 2 });
  });

  it("still matches once the parser appends the original deal date", () => {
    expect(installmentInfo("תשלום 8 מתוך 12 · עסקה מקורית: 2025-09-28")).toEqual({ n: 8, of: 12 });
  });

  it("still matches once a judgment note is appended", () => {
    // run_job.py concatenates judgment notes onto the parser note with " · ".
    expect(installmentInfo("תשלום 5 מתוך 13 · לא זוהה סיווג ודאי")).toEqual({ n: 5, of: 13 });
  });

  it("returns null for notes with no installment marker", () => {
    for (const note of ["", 'עסקת חו"ל', "ביטול עסקה", "עסקה שטרם נקלטה", "תשלום חודשי", "הוראת קבע"]) {
      expect(installmentInfo(note)).toBeNull();
    }
  });

  it("returns null for a missing note", () => {
    expect(installmentInfo(null)).toBeNull();
    expect(installmentInfo(undefined)).toBeNull();
  });

  // The bounded gap is what stops "תשלום" in one clause and digits from an
  // unrelated later clause — notes are concatenated — from bridging a match.
  it("does not bridge an unbounded gap between תשלום and the numbers", () => {
    const far = `תשלום${"x".repeat(25)}3 מתוך 6`;
    expect(installmentInfo(far)).toBeNull();
    const near = `תשלום${"x".repeat(5)}3 מתוך 6`;
    expect(installmentInfo(near)).toEqual({ n: 3, of: 6 });
  });

  it("requires the מתוך form — a bare number is not an installment", () => {
    expect(installmentInfo("תשלום 8")).toBeNull();
    expect(installmentInfo("8 מתוך 12")).toBeNull();
  });
});
