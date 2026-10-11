import { describe, expect, it } from "vitest";
import { isAuthorized } from "./auth";

describe("isAuthorized", () => {
  const token = "a1b2c3d4e5";

  it("accepts a matching bearer token", () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
  });

  it("is case-insensitive about the scheme and tolerant of spaces", () => {
    expect(isAuthorized(`bearer  ${token}`, token)).toBe(true);
  });

  it("rejects wrong tokens, empty headers and missing tokens", () => {
    expect(isAuthorized("Bearer nope", token)).toBe(false);
    expect(isAuthorized(undefined, token)).toBe(false);
    expect(isAuthorized("Bearer ", token)).toBe(false);
    expect(isAuthorized(`Bearer ${token}`, "")).toBe(false);
  });

  it("rejects non-bearer schemes", () => {
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
  });

  it("does not throw on length mismatch", () => {
    expect(isAuthorized("Bearer short", token)).toBe(false);
    expect(isAuthorized(`Bearer ${`${token}${token}`}`, token)).toBe(false);
  });
});
