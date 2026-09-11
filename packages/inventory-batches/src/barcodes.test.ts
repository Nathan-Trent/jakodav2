import { describe, expect, it } from "vitest";
import { isValidEan13, ManualBarcodeSchema } from "./barcodes.js";

describe("isValidEan13", () => {
  it("accepts a real EAN-13", () => {
    expect(isValidEan13("4006381333931")).toBe(true); // well-known example
    expect(isValidEan13("2000000000008")).toBe(true); // in-store prefix, check digit 8
  });
  it("rejects a bad check digit or wrong length", () => {
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("400638133393")).toBe(false);
  });
});

describe("ManualBarcodeSchema", () => {
  it("trims and accepts common formats", () => {
    expect(ManualBarcodeSchema.parse(" 012345678905 ")).toBe("012345678905");
    expect(ManualBarcodeSchema.parse("ABC-123_x.9")).toBe("ABC-123_x.9");
  });
  it("rejects junk", () => {
    expect(() => ManualBarcodeSchema.parse("ab")).toThrow();
    expect(() => ManualBarcodeSchema.parse("has space")).toThrow();
  });
});
