import { parseAustrianNumber } from "./oekb-extractor.ts";
import type { OekbExtraction } from "./oekb-extractor.ts";

export type OekbReport = {
  isin: string;
  fundName: string;
  reportId: string;
  reportDate: string;
  annual: boolean;
  validUntil: string | null;
};

export type OekbReportHistoryItem = Pick<OekbReport, "reportId" | "reportDate" | "fundName">;

export type OekbReportPrediction = {
  expectedDate: string;
  windowStart: string;
  windowEnd: string;
  confidence: "high" | "medium" | "low";
  sampleSize: number;
  typicalIntervalDays: number;
};

export type OekbAutomaticExtraction = OekbExtraction & {
  reportId: string;
  reportedDistributionPerUnit: number | null;
  unreportedDistributionPerUnit: number | null;
  sourceUrl: string;
  source: "OeKB öffentlicher CSV-Export";
};

export function parseSemicolonCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      row.push(cell.trim().replace(/^\uFEFF/, ""));
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell.trim().replace(/^\uFEFF/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  row.push(cell.trim().replace(/^\uFEFF/, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function toIsoDate(value: string): string | null {
  const match = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("de-AT");
}

export function parseOekbReportList(csv: string): OekbReport[] {
  const rows = parseSemicolonCsv(csv);
  const headerIndex = rows.findIndex((row) => row[0] === "ISIN" && row.includes("Melde-ID"));
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const column = (name: string) => header.indexOf(name);

  return rows.slice(headerIndex + 1).flatMap((row) => {
    const reportDate = toIsoDate(row[column("Meldedatum")] ?? "");
    const reportId = row[column("Melde-ID")]?.trim();
    const isin = row[column("ISIN")]?.trim().toUpperCase();
    if (!reportDate || !reportId || !isin) return [];
    return [{
      isin,
      fundName: row[column("Bezeichnung")]?.trim() ?? "",
      reportId,
      reportDate,
      annual: normalized(row[column("Jahresdatenmeldung")] ?? "") === "ja",
      validUntil: toIsoDate(row[column("Gültig bis")] ?? ""),
    }];
  });
}

export function availableReportYears(reports: OekbReport[], isin: string): string[] {
  return [...new Set(reports
    .filter((report) => report.isin === isin.toUpperCase() && report.annual && !report.validUntil)
    .map((report) => report.reportDate.slice(0, 4)))]
    .sort((a, b) => b.localeCompare(a));
}

export function selectAnnualReport(reports: OekbReport[], isin: string, taxYear?: string): OekbReport | null {
  const candidates = reports
    .filter((report) => report.isin === isin.toUpperCase() && report.annual && !report.validUntil)
    .filter((report) => !taxYear || report.reportDate.startsWith(`${taxYear}-`))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || Number(b.reportId) - Number(a.reportId));
  return candidates[0] ?? null;
}

export function annualReportHistory(reports: OekbReport[], isin: string): OekbReportHistoryItem[] {
  const newestByDate = new Map<string, OekbReport>();
  for (const report of reports) {
    if (report.isin !== isin.toUpperCase() || !report.annual) continue;
    const existing = newestByDate.get(report.reportDate);
    if (!existing || Number(report.reportId) > Number(existing.reportId)) newestByDate.set(report.reportDate, report);
  }
  return [...newestByDate.values()]
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate))
    .slice(0, 8)
    .map(({ reportId, reportDate, fundName }) => ({ reportId, reportDate, fundName }));
}

const DAY_MS = 86_400_000;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

export function predictNextAnnualReport(reports: OekbReport[], isin: string): OekbReportPrediction | null {
  const history = annualReportHistory(reports, isin)
    .map((report) => new Date(`${report.reportDate}T00:00:00Z`))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (history.length < 2) return null;

  const recent = history.slice(-6);
  const intervals = recent.slice(1).map((date, index) => Math.round((date.getTime() - recent[index].getTime()) / DAY_MS));
  const plausibleIntervals = intervals.filter((days) => days >= 250 && days <= 480);
  if (plausibleIntervals.length === 0) return null;

  const typicalIntervalDays = median(plausibleIntervals);
  const deviations = plausibleIntervals.map((days) => Math.abs(days - typicalIntervalDays));
  const medianDeviation = median(deviations);
  const windowDays = Math.min(60, Math.max(14, Math.round(medianDeviation * 2 + 7)));
  const expected = new Date(recent.at(-1)!.getTime() + typicalIntervalDays * DAY_MS);
  const confidence = plausibleIntervals.length >= 3 && medianDeviation <= 15
    ? "high"
    : plausibleIntervals.length >= 2 && medianDeviation <= 35
      ? "medium"
      : "low";

  return {
    expectedDate: isoDate(expected),
    windowStart: isoDate(new Date(expected.getTime() - windowDays * DAY_MS)),
    windowEnd: isoDate(new Date(expected.getTime() + windowDays * DAY_MS)),
    confidence,
    sampleSize: recent.length,
    typicalIntervalDays,
  };
}

function findPair(rows: string[][], label: string): string | null {
  const target = normalized(label);
  const row = rows.find((candidate) => normalized(candidate[0] ?? "") === target);
  return row?.[1]?.trim() || null;
}

export function parseOekbDetail(csv: string, expectedReport: OekbReport): OekbAutomaticExtraction | null {
  const rows = parseSemicolonCsv(csv);
  const taxHeaderIndex = rows.findIndex((row) => row[0] === "BEZEICHNUNG" && row.includes("STEUERNAME"));
  if (taxHeaderIndex < 0) return null;

  const header = rows[taxHeaderIndex];
  const valueIndex = Math.max(header.indexOf("PA_OHNE_OPTION"), header.indexOf("PA_MIT_OPTION"));
  const codeIndex = header.indexOf("STEUERNAME");
  const taxRows = rows.slice(taxHeaderIndex + 1).filter((row) => row.length > codeIndex && row[codeIndex]);
  const byCode = new Map(taxRows.map((row) => [row[codeIndex], row]));

  const valueFor = (code: string, fallback: RegExp): { value: number | null; evidence: string | null } => {
    const row = byCode.get(code) ?? taxRows.find((candidate) => fallback.test(candidate[0] ?? ""));
    return {
      value: row ? parseAustrianNumber(row[valueIndex] ?? "") : null,
      evidence: row ? `${row[0]}: ${row[valueIndex]}` : null,
    };
  };

  const reported = valueFor("StB_E1KV_Ausschuettungen", /^Ausschüttungen 27,5%/i);
  const unreported = valueFor("StB_E1KV_Ausschuettungen_nichtgemeldet", /nicht gemeldete unterjährige Ausschüttungen/i);
  const deemed = valueFor("StB_E1KV_AGErtraege", /^Ausschüttungsgleiche Erträge 27,5%/i);
  const credit = valueFor("StB_E1KV_anzurechnende_ausl_Quellensteuer", /Anzurechnende ausländische.*Quellen.*Steuer/i);
  const adjustment = valueFor("StB_E1KV_Korrekturbetrag_saldiert", /Anschaffungskosten des Fondsanteils sind zu korrigieren/i);
  const actual = reported.value === null && unreported.value === null
    ? null
    : (reported.value ?? 0) + (unreported.value ?? 0);
  const currency = findPair(rows, "Währung, in der die Meldung vorgenommen wurde")?.toUpperCase() ?? null;
  const isin = findPair(rows, "ISIN")?.toUpperCase() ?? expectedReport.isin;
  const reportDate = toIsoDate(findPair(rows, "Meldedatum") ?? "") ?? expectedReport.reportDate;
  const reportId = findPair(rows, "Melde-ID") ?? expectedReport.reportId;
  const fundName = findPair(rows, "Name der Anteilsgattung des Fonds") ?? expectedReport.fundName;
  const warnings: string[] = [];

  if (unreported.value !== null && unreported.value !== 0) {
    warnings.push(`Zusätzlich wurden ${unreported.value.toLocaleString("de-AT")} je Anteil nicht gemeldete unterjährige Ausschüttungen in den Wert für tatsächliche Ausschüttungen eingerechnet. Zuflussjahr und Bestand mit dem Depotauszug prüfen.`);
  }
  return {
    isin,
    fundName,
    currency,
    reportDate,
    reportId,
    eurRate: currency === "EUR" ? 1 : null,
    actualDistributionPerUnit: actual,
    reportedDistributionPerUnit: reported.value,
    unreportedDistributionPerUnit: unreported.value,
    deemedIncomePerUnit: deemed.value,
    creditableForeignTaxPerUnit: credit.value,
    costBasisAdjustmentPerUnit: adjustment.value,
    evidence: {
      eurRate: currency === "EUR" ? "Fondswährung EUR" : null,
      actualDistributionPerUnit: [reported.evidence, unreported.evidence].filter(Boolean).join(" + ") || null,
      deemedIncomePerUnit: deemed.evidence,
      creditableForeignTaxPerUnit: credit.evidence,
      costBasisAdjustmentPerUnit: adjustment.evidence,
    },
    warnings,
    source: "OeKB öffentlicher CSV-Export",
    sourceUrl: `https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f?isin=${encodeURIComponent(isin)}`,
  };
}
