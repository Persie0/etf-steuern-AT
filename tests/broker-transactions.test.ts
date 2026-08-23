import assert from "node:assert/strict";
import test from "node:test";
import { currentUnitsByIsin, parseBrokerPdfText, parseLocaleNumber, unitsAtDate } from "../lib/broker-transactions.ts";
import type { BrokerTransaction } from "../lib/broker-transactions.ts";
import { layoutPdfTextItems } from "../lib/pdf-text.ts";

test("parses a German Scalable Capital purchase confirmation", () => {
  const result = parseBrokerPdfText(`Scalable Capital\nWertpapierabrechnung Kauf\nVanguard FTSE All-World UCITS ETF\nISIN IE00BK5BQT80\nStück 12,345\nAusführungstag 18.01.2024\nAbrechnungsbetrag 1.234,56 EUR`, "kauf.pdf");
  assert.equal(result.broker, "Scalable Capital");
  assert.deepEqual(result.transactions[0], { sourceFile: "kauf.pdf", broker: "Scalable Capital", type: "buy", isin: "IE00BK5BQT80", securityName: "Vanguard FTSE All-World UCITS ETF", date: "2024-01-18", units: 12.345, amount: 1234.56, currency: "EUR", confidence: "high", evidence: result.transactions[0].evidence });
});

test("parses an English IBKR sale confirmation", () => {
  const result = parseBrokerPdfText(`Interactive Brokers\nSell\nVanguard FTSE All-World UCITS ETF\nISIN IE00BK5BQT80\nQuantity: 2.5 Shares\nTrade date 2025-02-03\nTotal 325.00 USD`, "sale.pdf");
  assert.equal(result.transactions[0].type, "sell");
  assert.equal(result.transactions[0].units, 2.5);
  assert.equal(result.transactions[0].currency, "USD");
});

test("parses modern flatex purchase layout with currency before Endbetrag", () => {
  const result = parseBrokerPdfText(`flatexDEGIRO Bank SE\nWertpapierabrechnung Kauf\nAuftragsdatum 15.01.2026\nNr.123456789/1 Kauf VANGUARD FTSE ALL-WORLD UCITS ETF (IE00BK5BQT80/A1JX52)\nAusgeführt : 29 St. Kurswert : 3.721,28 EUR\nHandelstag 16.01.2026\nEndbetrag EUR -3.727,18`, "flatex-kauf.pdf");
  assert.equal(result.broker, "Flatex");
  assert.deepEqual(result.transactions[0], { sourceFile: "flatex-kauf.pdf", broker: "Flatex", type: "buy", isin: "IE00BK5BQT80", securityName: "VANGUARD FTSE ALL-WORLD UCITS ETF", date: "2026-01-16", units: 29, amount: 3727.18, currency: "EUR", confidence: "high", evidence: result.transactions[0].evidence });
});

test("parses legacy flatex sale layout with fractional shares and amount before currency", () => {
  const result = parseBrokerPdfText(`FinTech Group Bank AG\nWertpapierabrechnung Verkauf\nNr.76443716/1 Verkauf UBS ETF MSCI WORLD (IE00B7KQ7B66/A1W3CQ)\nAusgeführt 19,334524 St. Kurswert EUR 1.050,00\nSchlusstag 17.01.2019 Ausführungszeit 17:52 Uhr\nEndbetrag : 1.040,20 EUR`, "flatex-verkauf.pdf");
  assert.equal(result.transactions[0].type, "sell");
  assert.equal(result.transactions[0].units, 19.334524);
  assert.equal(result.transactions[0].amount, 1040.2);
  assert.equal(result.transactions[0].date, "2019-01-17");
});

test("does not mis-import flatex tax notices as purchases", () => {
  const result = parseBrokerPdfText(`flatex\nNr.5037861458 INVESCO FTSE ALL-WORLD UC\nSt. : 2.842,99 Bruttothesaurierung\npro Stück : 0,0946 USD\nExtag : 16.06.2026\nEndbetrag : -45,85 EUR`, "steuer.pdf");
  assert.equal(result.broker, "Flatex");
  assert.equal(result.transactions.length, 0);
  assert.match(result.warnings.join(" "), /Dokumentlayout/);
});

test("handles German thousands and decimal separators without losing units", () => {
  assert.equal(parseLocaleNumber("2.842,99"), 2842.99);
  assert.equal(parseLocaleNumber("1.000"), 1000);
  assert.equal(parseLocaleNumber("19,334524"), 19.334524);
  assert.equal(parseLocaleNumber("325.00"), 325);
});

test("reconstructs PDF lines from positioned text items", () => {
  const text = layoutPdfTextItems([
    { str: "Endbetrag", transform: [1, 0, 0, 10, 10, 100], width: 45, height: 10 },
    { str: "EUR", transform: [1, 0, 0, 10, 100, 100], width: 18, height: 10 },
    { str: "-3.727,18", transform: [1, 0, 0, 10, 145, 100], width: 50, height: 10 },
    { str: "Handelstag", transform: [1, 0, 0, 10, 10, 80], width: 50, height: 10 },
    { str: "16.01.2026", transform: [1, 0, 0, 10, 100, 80], width: 55, height: 10 },
  ]);
  assert.match(text.split("\n")[0], /^Endbetrag\s+EUR\s+-3\.727,18$/);
  assert.match(text.split("\n")[1], /^Handelstag\s+16\.01\.2026$/);
});

test("calculates historical and current units from buys and sells", () => {
  const base = { sourceId: "x", sourceFile: "x.pdf", importedAt: "2025-01-01T00:00:00Z", broker: null, isin: "IE00BK5BQT80", securityName: null, amount: null, currency: null, confidence: "medium" as const, evidence: "test" };
  const transactions: BrokerTransaction[] = [
    { ...base, id: "1", type: "buy", date: "2023-01-02", units: 10 },
    { ...base, id: "2", type: "buy", date: "2024-02-02", units: 5 },
    { ...base, id: "3", type: "sell", date: "2025-02-02", units: 4 },
  ];
  assert.deepEqual(unitsAtDate(transactions, base.isin, "2024-01-15"), { units: 10, matchedTransactions: 1 });
  assert.equal(currentUnitsByIsin(transactions)[0].units, 11);
});
