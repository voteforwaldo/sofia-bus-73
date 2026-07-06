export function formatCelsius(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;

  const rounded = Math.round(value * 10) / 10;
  const formatted = new Intl.NumberFormat("bg-BG", {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(rounded);

  return `${formatted}°C`;
}

export function formatTemperatureLine(temperature, feelsLike, condition) {
  const main = formatCelsius(temperature);
  if (!main) return "";

  const feels = formatCelsius(feelsLike);
  const hasFeelsLike =
    feelsLike != null &&
    feels &&
    Math.abs(temperature - feelsLike) >= 0.4;

  if (hasFeelsLike) {
    return `${main} · усеща се ${feels} · ${condition}`;
  }

  return `${main} · ${condition}`;
}
