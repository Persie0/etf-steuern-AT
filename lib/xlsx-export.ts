import { strToU8, zipSync } from "fflate";
import { brokerTransactionTypeLabels, holdingDeltaForTransaction } from "./broker-transactions";
import type { BrokerTransaction } from "./broker-transactions";

type PortfolioRow = {
  identifier: string; taxYear: string; status: string; ownershipStatus: string; savedAt: string;
  values: Record<string, number>; security?: { name?: string | null } | null;
  oekbResult?: { reportDate?: string | null; source?: string } | null;
  result: Record<string, number>; reportTracking?: { state?: string; message?: string | null; prediction?: { expectedDate?: string } | null };
  showSale?: boolean; saleCurrency?: string; saleDate?: string;
};

const esc = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const columnName = (index: number) => {
  let value = index + 1, result = "";
  while (value) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
};

function cell(value: unknown, row: number, column: number, style = 0): string {
  const ref = `${columnName(column)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheet(rows: unknown[][], widths: number[], moneyColumns: number[] = [], numberColumns: number[] = []): string {
  const content = rows.map((values, rowIndex) => `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="24" customHeight="1"' : ""}>${values.map((value, columnIndex) => cell(value, rowIndex + 1, columnIndex, rowIndex === 0 ? 1 : moneyColumns.includes(columnIndex) ? 2 : numberColumns.includes(columnIndex) ? 3 : 0)).join("")}</row>`).join("");
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const last = `${columnName(Math.max(0, (rows[0]?.length ?? 1) - 1))}${Math.max(1, rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${content}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

export function buildPortfolioWorkbook(portfolio: PortfolioRow[], transactions: BrokerTransaction[]): Uint8Array {
  const years = [...new Set(portfolio.map((entry) => entry.taxYear))].sort();
  const summaryRows: unknown[][] = [["ETF-Steuerassistent Österreich – Export", "Wert"], ["Exportiert am", new Date().toISOString()], ["Gespeicherte ETF-Jahre", portfolio.length], ["Importierte Broker-Ereignisse", transactions.length], ["", ""], ["Steuerjahr", "KZ 898", "KZ 937", "KZ 994", "KZ 892", "KZ 998", "Steuerpflichtige Basis", "Steuerschätzung"]];
  for (const year of years) {
    const entries = portfolio.filter((entry) => entry.taxYear === year && entry.reportTracking?.state !== "pending");
    const sum = (key: string) => entries.reduce((total, entry) => total + Number(entry.result[key] ?? 0), 0);
    summaryRows.push([year, sum("kz898"), sum("kz937"), sum("kz994"), sum("kz892"), sum("kz998"), sum("taxableTotal"), sum("estimatedTax")]);
  }
  const etfHeaders = ["ISIN/WKN", "ETF", "Steuerjahr", "Fondsstatus", "Position", "Meldestatus", "OeKB-Meldetag", "Stück am Meldetag", "EUR/FW", "Ausschüttung je Anteil", "agE je Anteil", "Quellensteuer je Anteil", "AK-Korrektur je Anteil", "Ursprüngliche AK", "AK-Korrektur gesamt", "Fortgeschriebene AK", "Verkaufstag", "Verkaufswährung", "Verkaufserlös", "KZ 898", "KZ 937", "KZ 994", "KZ 892", "KZ 998", "Steuerpflichtige Basis", "Steuerschätzung", "Quelle", "Gespeichert am"];
  const etfRows = portfolio.map((entry) => [entry.identifier, entry.security?.name ?? entry.identifier, entry.taxYear, entry.status === "reporting" ? "Meldefonds" : "Nicht-Meldefonds", entry.ownershipStatus === "held" ? "gehalten" : "verkauft", entry.reportTracking?.state ?? "berechnet", entry.oekbResult?.reportDate ?? "", entry.values.units ?? 0, entry.values.eurRate ?? 1, entry.values.distributionsPerUnit ?? 0, entry.values.deemedIncomePerUnit ?? 0, entry.values.creditableTaxPerUnit ?? 0, entry.values.costAdjustmentPerUnit ?? 0, entry.values.baseAcquisitionCost ?? 0, entry.result.costAdjustment ?? 0, (entry.values.baseAcquisitionCost ?? 0) + (entry.result.costAdjustment ?? 0), entry.saleDate ?? "", entry.saleCurrency ?? "EUR", entry.values.saleProceeds ?? 0, entry.result.kz898 ?? 0, entry.result.kz937 ?? 0, entry.result.kz994 ?? 0, entry.result.kz892 ?? 0, entry.result.kz998 ?? 0, entry.result.taxableTotal ?? 0, entry.result.estimatedTax ?? 0, entry.oekbResult?.source ?? "", entry.savedAt]);
  const txHeaders = ["Datum", "Art", "ISIN", "ETF/Wertpapier", "Bestandsänderung Stück", "Bezugs-/Bestandsstück", "Broker", "Netto-Betrag", "Währung", "Brutto-Betrag", "Brutto-Währung", "Steuer", "Gebühr", "Devisenkurs", "PDF-Datei", "Erkennung", "Importiert am"];
  const txRows = transactions.slice().sort((a, b) => a.date.localeCompare(b.date)).map((item) => [
    item.date,
    brokerTransactionTypeLabels[item.type],
    item.isin ?? "",
    item.securityName ?? "",
    holdingDeltaForTransaction(item),
    item.units ?? "",
    item.broker ?? "",
    item.amount ?? "",
    item.currency ?? "",
    item.grossAmount ?? "",
    item.grossCurrency ?? "",
    item.taxAmount ?? "",
    item.feeAmount ?? "",
    item.exchangeRate ?? "",
    item.sourceFile,
    item.confidence === "high" ? "hoch" : item.confidence === "medium" ? "mittel" : "niedrig",
    item.importedAt,
  ]);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${[1,2,3].map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Übersicht" sheetId="1" r:id="rId1"/><sheet name="ETF-Jahresdaten" sheetId="2" r:id="rId2"/><sheet name="Transaktionen" sheetId="3" r:id="rId3"/></sheets><calcPr calcMode="auto" fullCalcOnLoad="1"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1,2,3].map((n) => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join("")}<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00 [$€-407]"/><numFmt numFmtId="165" formatCode="0.000000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF174F3D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf fontId="0" fillId="0" borderId="0" xfId="0" numFmtId="164" applyNumberFormat="1"/><xf fontId="0" fillId="0" borderId="0" xfId="0" numFmtId="165" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet(summaryRows, [34, 22, 18, 18, 18, 18, 24, 22], [1,2,3,4,5,6,7])),
    "xl/worksheets/sheet2.xml": strToU8(sheet([etfHeaders, ...etfRows], etfHeaders.map((header) => Math.min(28, Math.max(13, header.length + 2))), [13,14,15,18,19,20,21,22,23,24,25], [7,8,9,10,11,12])),
    "xl/worksheets/sheet3.xml": strToU8(sheet([txHeaders, ...txRows], [14,20,18,28,22,20,20,16,12,16,15,14,14,14,28,14,24], [7,9,11,12], [4,5,13])),
  };
  return zipSync(files, { level: 6 });
}
