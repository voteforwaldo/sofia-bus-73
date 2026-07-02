const RAIN_CODES = new Set([
  51, 52, 53, 54, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 85, 86, 95, 96, 99,
]);

const SNOW_CODES = new Set([71, 73, 75, 77]);

export const PRECIPITATION_CODES = new Set([...RAIN_CODES, ...SNOW_CODES]);

export function weatherLabel(code) {
  if (code === 0) return "ясно";
  if (code <= 3) return "облачно";
  if (SNOW_CODES.has(code)) return "сняг";
  if (RAIN_CODES.has(code)) return "дъжд";
  if (code === 45 || code === 48) return "мъгла";
  return "променливо";
}
