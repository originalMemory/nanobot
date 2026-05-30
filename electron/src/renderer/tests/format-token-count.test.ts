import { describe, expect, it } from "vitest";
import { formatTokenCount } from "@/lib/utils";

describe("formatTokenCount", () => {
  it("returns raw string for numbers < 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1)).toBe("1");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats numbers >= 1000 as Xk", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1200)).toBe("1.2k");
    expect(formatTokenCount(64300)).toBe("64.3k");
    expect(formatTokenCount(999900)).toBe("999.9k");
  });

  it("formats numbers >= 1_000_000 as Xm", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0m");
    expect(formatTokenCount(1_200_000)).toBe("1.2m");
    expect(formatTokenCount(10_500_000)).toBe("10.5m");
  });
});
