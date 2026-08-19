import assert from "node:assert/strict";
import test from "node:test";
import { availableReportYears, parseOekbDetail, parseOekbReportList, parseSemicolonCsv, selectAnnualReport } from "../lib/oekb-csv.ts";

const listFixture = `ISIN;Bezeichnung;Melde-ID;Meldedatum;Gültig bis;Jahresdatenmeldung;Ausschüttungsmeldung;Selbstnachweis
IE00B4L5Y983;iShares Core MSCI World UCITS ETF USD(Acc);637679;18.12.2025;;JA;NEIN;NEIN
IE00B4L5Y983;iShares Core MSCI World UCITS ETF USD(Acc);563531;09.01.2025;;JA;NEIN;NEIN
IE00B4L5Y983;iShares Core MSCI World UCITS ETF USD(Acc);483461;18.12.2023;01.02.2024;JA;NEIN;NEIN
IE00B4L5Y983;iShares Core MSCI World UCITS ETF USD(Acc);470000;01.06.2024;;NEIN;JA;NEIN`;

const detailFixture = `BASISINFORMATION Anteilsgattung - Stammdaten
======================================
ISIN;IE00B4L5Y983
Name der Anteilsgattung des Fonds;iShares Core MSCI World UCITS ETF USD(Acc)

BASISINFORMATION Steuermeldung - Weitere Informationen
======================================
Meldedatum;18.12.2025
Währung, in der die Meldung vorgenommen wurde;USD
Melde-ID;637679

Kennzahlen ESt-Erklärung Privatanleger (je Anteil)
======================================
BEZEICHNUNG;PA_MIT_OPTION;PA_OHNE_OPTION;STEUERNAME;STEUERCODE
Ausschüttungen 27,5% (Kennzahlen 897 oder 898);0,0000;0,0000;StB_E1KV_Ausschuettungen;10286
Vorsicht: Vom Fonds wurden nicht gemeldete unterjährige Ausschüttungen getätigt;0,1000;0,1000;StB_E1KV_Ausschuettungen_nichtgemeldet;10595
Ausschüttungsgleiche Erträge 27,5%;1,3188;1,3188;StB_E1KV_AGErtraege;10287
Anzurechnende ausländische (Quellen)Steuer;0,1326;0,1326;StB_E1KV_anzurechnende_ausl_Quellensteuer;10288
Die Anschaffungskosten des Fondsanteils sind zu korrigieren um;1,1020;1,1020;StB_E1KV_Korrekturbetrag_saldiert;10289`;

test("parses quoted semicolon CSV values", () => {
  assert.deepEqual(parseSemicolonCsv('A;"Text; mit Trennzeichen";"ein ""Zitat"""\r\n1;2;3'), [
    ["A", "Text; mit Trennzeichen", 'ein "Zitat"'],
    ["1", "2", "3"],
  ]);
});

test("selects the latest valid annual report in the requested tax year", () => {
  const reports = parseOekbReportList(listFixture);
  assert.deepEqual(availableReportYears(reports, "IE00B4L5Y983"), ["2025"]);
  assert.equal(selectAnnualReport(reports, "IE00B4L5Y983", "2025")?.reportId, "637679");
  assert.equal(selectAnnualReport(reports, "IE00B4L5Y983", "2024"), null);
});

test("extracts and combines OeKB private-investor tax values", () => {
  const report = selectAnnualReport(parseOekbReportList(listFixture), "IE00B4L5Y983", "2025");
  assert.ok(report);
  const result = parseOekbDetail(detailFixture, report);
  assert.ok(result);
  assert.equal(result.reportId, "637679");
  assert.equal(result.currency, "USD");
  assert.equal(result.actualDistributionPerUnit, 0.1);
  assert.equal(result.deemedIncomePerUnit, 1.3188);
  assert.equal(result.creditableForeignTaxPerUnit, 0.1326);
  assert.equal(result.costBasisAdjustmentPerUnit, 1.102);
  assert.equal(result.warnings.length, 1);
});
