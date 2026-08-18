export type OekbExtraction = {
  isin: string | null;
  fundName: string | null;
  currency: string | null;
  reportDate: string | null;
  eurRate: number | null;
  actualDistributionPerUnit: number | null;
  deemedIncomePerUnit: number | null;
  creditableForeignTaxPerUnit: number | null;
  costBasisAdjustmentPerUnit: number | null;
  evidence: Record<string, string | null>;
  warnings: string[];
  model?: string;
  exchangeRateSource?: string;
  exchangeRateDate?: string;
};

const numberPattern = /-?\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|-?\d+(?:[.,]\d+)?/;

export function parseAustrianNumber(raw: string): number | null {
  const value = raw.trim().replace(/\s/g, "");
  if (!value) return null;
  let normalized = value;
  if (value.includes(",") && value.includes(".")) normalized = value.replace(/\./g, "").replace(",", ".");
  else if (value.includes(",")) normalized = value.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function findAfterLabel(text: string, labels: string[]): { value: number; evidence: string } | null {
  const folded = text.toLocaleLowerCase("de-AT");
  for (const label of labels) {
    const index = folded.indexOf(label.toLocaleLowerCase("de-AT"));
    if (index < 0) continue;
    const snippet = text.slice(index, index + 280).replace(/\s+/g, " ").trim();
    const tail = snippet.slice(label.length);
    const match = tail.match(numberPattern);
    if (!match) continue;
    const value = parseAustrianNumber(match[0]);
    if (value !== null) return { value, evidence: snippet.slice(0, 180) };
  }
  return null;
}

/** Conservative fallback for copied OeKB text. It intentionally leaves ambiguous fields empty. */
export function parseOekbTextLocally(text: string): OekbExtraction {
  const isin = text.match(/\b[A-Z]{2}[A-Z0-9]{9}\d\b/i)?.[0]?.toUpperCase() ?? null;
  const reportDateMatch = text.match(/(?:Meldedatum|Datum der Meldung)[^\d]{0,30}(\d{1,2}\.\d{1,2}\.\d{4})/i);
  const reportDate = reportDateMatch ? reportDateMatch[1].split(".").reverse().map((part) => part.padStart(2, "0")).join("-") : null;
  const currency = text.match(/(?:Fondswährung|Währung)[^A-Z]{0,25}\b(EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK|HUF)\b/i)?.[1]?.toUpperCase() ?? null;
  const actual = findAfterLabel(text, ["Tatsächliche Ausschüttung je Anteil", "Ausschüttungen je Anteil"]);
  const deemed = findAfterLabel(text, ["Ausschüttungsgleiche Erträge je Anteil", "ausschüttungsgleiche Erträge"]);
  const credit = findAfterLabel(text, ["Anrechenbare Quellensteuer je Anteil", "anrechenbare ausländische Quellensteuer"]);
  const adjustment = findAfterLabel(text, ["Korrektur Anschaffungskosten je Anteil", "Anschaffungskosten des Fondsanteils sind zu korrigieren um"]);
  const rate = findAfterLabel(text, ["EUR-Umrechnungskurs", "EUR / FW"]);

  return {
    isin,
    fundName: null,
    currency,
    reportDate,
    eurRate: rate?.value ?? (currency === "EUR" ? 1 : null),
    actualDistributionPerUnit: actual?.value ?? null,
    deemedIncomePerUnit: deemed?.value ?? null,
    creditableForeignTaxPerUnit: credit?.value ?? null,
    costBasisAdjustmentPerUnit: adjustment?.value ?? null,
    evidence: {
      eurRate: rate?.evidence ?? null,
      actualDistributionPerUnit: actual?.evidence ?? null,
      deemedIncomePerUnit: deemed?.evidence ?? null,
      creditableForeignTaxPerUnit: credit?.evidence ?? null,
      costBasisAdjustmentPerUnit: adjustment?.evidence ?? null,
    },
    warnings: [],
  };
}

