/**
 * The SETTING_KEYS allowlist is the trust boundary for the generic settings PUT
 * route (`/admin/api/settings/[key]`). isSettingKey must accept exactly the
 * known keys and reject everything else — a false positive would let the route
 * write an arbitrary AppSetting row (e.g. the encrypted `drive_oauth` token).
 */
import { describe, it, expect } from "vitest";
import { isSettingKey, SETTING_KEYS } from "@/lib/appSettings";

describe("isSettingKey — the settings allowlist", () => {
  it("accepts every declared key", () => {
    for (const k of SETTING_KEYS) expect(isSettingKey(k)).toBe(true);
  });

  it("rejects keys that are not on the allowlist", () => {
    for (const k of ["drive_oauth", "", "summary_instructions ", "SUMMARY_INSTRUCTIONS", "__proto__", "report_rules; drop"]) {
      expect(isSettingKey(k)).toBe(false);
    }
  });

  it("narrows the type so an arbitrary string cannot be written as a key", () => {
    const candidate: string = "not_a_setting";
    // isSettingKey is the ONLY gate the route uses before setSetting — this test
    // documents that contract.
    expect(isSettingKey(candidate)).toBe(false);
  });
});
