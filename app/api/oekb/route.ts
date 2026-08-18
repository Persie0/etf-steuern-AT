import { availableReportYears, parseOekbDetail, parseOekbReportList, selectAnnualReport } from "../../../lib/oekb-csv";

export const runtime = "edge";

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const OEK_B_REPORTING_URL = "https://my.oekb.at/kms-reporting/public";

async function fetchCsv(parameters: Record<string, string>): Promise<string> {
  const url = new URL(OEK_B_REPORTING_URL);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { accept: "text/comma-separated-values,text/csv;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OeKB HTTP ${response.status}`);
  return response.text();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const isin = (url.searchParams.get("isin") ?? "").trim().toUpperCase();
  const taxYear = (url.searchParams.get("taxYear") ?? "").trim();
  if (!ISIN.test(isin)) {
    return Response.json({ error: "Für den automatischen OeKB-Abruf ist eine gültige ISIN erforderlich." }, { status: 400 });
  }
  if (taxYear && !/^20\d{2}$/.test(taxYear)) {
    return Response.json({ error: "Das Steuerjahr ist ungültig." }, { status: 400 });
  }

  let stage = "Meldungsliste";
  try {
    const listCsv = await fetchCsv({
      report: "steuermeldg-liste",
      fnameReplacement: isin,
      ART: "ALLE",
      ISIN: isin,
      sortField: "date",
      sortOrder: "-1",
      format: "CSV",
    });
    const reports = parseOekbReportList(listCsv);
    const availableYears = availableReportYears(reports, isin);
    const report = selectAnnualReport(reports, isin, taxYear || undefined);
    if (!report) {
      const message = availableYears.length
        ? `Für ${taxYear || "diese ISIN"} wurde keine gültige OeKB-Jahresmeldung gefunden. Verfügbar: ${availableYears.join(", ")}.`
        : "Für diese ISIN wurde keine gültige OeKB-Jahresmeldung gefunden.";
      return Response.json({ error: message, availableYears }, { status: 404 });
    }

    stage = "Jahresmeldung";
    const detailParameters = {
      fnameReplacement: report.reportId,
      MELDE_ID: report.reportId,
      BASIS: "",
      KENNZ_PRIVAT: "",
      format: "CSV",
    };
    let detailCsv = await fetchCsv({ report: "steuerdatenv6-detail", ...detailParameters });
    let extraction = parseOekbDetail(detailCsv, report);
    if (!extraction) {
      detailCsv = await fetchCsv({ report: "steuerdaten-detail", ...detailParameters });
      extraction = parseOekbDetail(detailCsv, report);
    }
    if (!extraction) throw new Error("OeKB-Detailformat nicht erkannt");

    return Response.json({ ...extraction, availableYears }, {
      headers: { "cache-control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return Response.json({
      error: `Die öffentliche OeKB-Abfrage ist gerade nicht erreichbar oder ihr Exportformat hat sich geändert (Schritt: ${stage}). Bitte später erneut versuchen oder den manuellen Notfall-Import verwenden.`,
    }, { status: 502 });
  }
}
