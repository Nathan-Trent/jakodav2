import { describe, expect, it } from "vitest";
import { formatNumberLive as formatLive, sanitizeNumber as sanitize } from "./numberFormat";

describe("number boxes — the contract", () => {
  it("can be empty", () => {
    expect(sanitize("", 2)).toBe("");
    expect(formatLive("", 2)).toBe("");
  });
  it("puts commas in the right places while typing", () => {
    expect(formatLive("1500", 2)).toBe("1,500");
    expect(formatLive("1500000", 2)).toBe("1,500,000");
    expect(formatLive("1500000.5", 2)).toBe("1,500,000.5");
    expect(formatLive("999", 0)).toBe("999");
    expect(formatLive("12000", 0)).toBe("12,000");
  });
  it("strips commas and junk the user pastes", () => {
    expect(sanitize("₦1,500.00", 2)).toBe("1500.00");
    expect(sanitize("1 500", 0)).toBe("1500");
  });
  it("allows at most two decimals for money and none for counts", () => {
    expect(sanitize("1500.555", 2)).toBe("1500.55");
    expect(sanitize("12.5", 0)).toBe("125");
  });
  it("keeps a lone zero and 0.x, drops leading zeros", () => {
    expect(sanitize("0", 2)).toBe("0");
    expect(sanitize("0.5", 2)).toBe("0.5");
    expect(sanitize("007", 2)).toBe("7");
  });
  it("tolerates a trailing dot mid-typing", () => {
    expect(sanitize("1500.", 2)).toBe("1500.");
    expect(formatLive("1500.", 2)).toBe("1,500.");
  });
});
