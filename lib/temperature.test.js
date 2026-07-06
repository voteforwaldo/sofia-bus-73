import { describe, expect, it } from "vitest";
import { fallbackNewsBrief, parseRssTitles } from "./rss.js";
import { formatCelsius, formatTemperatureLine } from "./temperature.js";

describe("formatCelsius", () => {
  it("formats with one decimal when needed", () => {
    expect(formatCelsius(23.44)).toMatch(/23,4°C/);
  });

  it("formats whole numbers without decimal", () => {
    expect(formatCelsius(24)).toMatch(/24°C/);
  });
});

describe("formatTemperatureLine", () => {
  it("includes feels-like when different", () => {
    const line = formatTemperatureLine(23.4, 25.1, "облачно");
    expect(line).toContain("усеща се");
    expect(line).toContain("облачно");
  });
});

describe("parseRssTitles", () => {
  it("extracts titles from rss xml", () => {
    const xml = `
      <rss><channel>
        <item><title><![CDATA[Първа новина]]></title></item>
        <item><title>Втора новина</title></item>
      </channel></rss>
    `;

    expect(parseRssTitles(xml)).toEqual(["Първа новина", "Втора новина"]);
  });
});

describe("fallbackNewsBrief", () => {
  it("joins top headlines", () => {
    const brief = fallbackNewsBrief(["A", "B", "C", "D"]);
    expect(brief).toContain("A");
    expect(brief).toContain("B");
    expect(brief).toContain("C");
    expect(brief).not.toContain("D");
  });
});
