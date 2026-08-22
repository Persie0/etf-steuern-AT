export function parseEditableNumber(raw: string): number {
  const normalized = raw.trim().replace(",", ".");
  if (!normalized || normalized === "-" || normalized === "." || normalized === "-.") return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
