import { describe, expect, it } from "vitest";
import { PRECIPITATION_CODES, weatherLabel } from "./weather.js";

describe("weatherLabel", () => {
  it("labels snow separately from rain", () => {
    expect(weatherLabel(71)).toBe("сняг");
    expect(weatherLabel(61)).toBe("дъжд");
  });

  it("tracks snow in precipitation codes", () => {
    expect(PRECIPITATION_CODES.has(71)).toBe(true);
    expect(PRECIPITATION_CODES.has(61)).toBe(true);
  });
});
