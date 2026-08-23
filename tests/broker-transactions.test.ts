import assert from "node:assert/strict";
import test from "node:test";
import { currentUnitsByIsin, holdingDeltaForTransaction, parseBrokerPdfText, parseLocaleNumber, unitsAtDate } from "../lib/broker-transactions.ts";
import type { BrokerTransaction } from "../lib/broker-transactions.ts";
import { layoutPdfTextItems } from "../lib/pdf-text.ts";

test("parses a German Scalable Capital purchase confirmation", () => {
  const result = parseBrokerPdfText(`Scalable Capital\nWertpapierabrechnung Kauf\nVanguard FTSE All-World UCITS ETF\nISIN IE00BK5BQT80\nStück 12,345\nAusführungstag 18.01.2024\nAbrechnungsbetrag 1.234,56 EUR`, "kauf.pdf");
  const transaction = result.transactions[0];
  assert.equal(result.broker, "Scalable Capital");
  assert.equal(transaction.type, "buy");
  assert.equal(transaction.isin, "IE00BK5BQT80");
  assert.equal(transaction.units, 12.345);
  assert.equal(transaction.amount, 1234.56);
  assert.equal(transaction.currency, "EUR");
  assert.equal(transaction.date, "2024-01-18");
});

test("parses an English IBKR sale confirmation", () => {
  const result = parseBrokerPdfText(`Interactive Brokers\nSell\nVanguard FTSE All-World UCITS ETF\nISIN IE00BK5BQT80\nQuantity: 2.5 Shares\nTrade date 2025-02-03\nTotal 325.00 USD`, "sale.pdf");
  assert.equal(result.transactions[0].type, "sell");
  assert.equal(result.transactions[0].units, 2.5);
  assert.equal(result.transactions[0].currency, "USD");
});

test("parses modern flatex purchase including order fees", () => {
  const result = parseBrokerPdfText(`flatexDEGIRO Bank SE\nWertpapierabrechnung Kauf\nAuftragsdatum 15.01.2026\nNr.123456789/1 Kauf VANGUARD FTSE ALL-WORLD UCITS ETF (IE00BK5BQT80/A1JX52)\nAusgeführt : 29 St. Kurswert : 3.721,28 EUR\nProvision : 5,90 EUR\nHandelstag 16.01.2026\nEndbetrag EUR -3.727,18`, "flatex-kauf.pdf");
  const transaction = result.transactions[0];
  assert.equal(result.broker, "Flatex");
  assert.equal(transaction.type, "buy");
  assert.equal(transaction.units, 29);
  assert.equal(transaction.amount, 3727.18);
  assert.equal(transaction.feeAmount, 5.9);
  assert.equal(transaction.date, "2026-01-16");
});

test("imports a Portfolio Performance-style flatex cash distribution", () => {
  const result = parseBrokerPdfText(`flatex Bank AG\nErtragsmitteilung - ausschüttender/teilthesaurierender Fonds\nNr.1609141241 VANG.FTSE DEV.EU.UETF EOD (IE00B945VV12/A1T8FS)\nSt. : 197,00 Bruttoausschüttung\npro Stück : 0,1831170 EUR\nExtag : 28.03.2019 Bruttoausschüttung : 36,07 EUR\nValuta : 10.04.2019\n*Einbeh. Steuer : 0,00 EUR\nEndbetrag : 36,07 EUR`, "flatex-dividende.pdf");
  const transaction = result.transactions[0];
  assert.equal(transaction.type, "dividend");
  assert.equal(transaction.isin, "IE00B945VV12");
  assert.equal(transaction.units, 197);
  assert.equal(transaction.amount, 36.07);
  assert.equal(transaction.grossAmount, 36.07);
  assert.equal(transaction.taxAmount, 0);
  assert.equal(transaction.date, "2019-04-10");
  assert.equal(holdingDeltaForTransaction(transaction), 0);
});

test("imports Austrian flatex Bruttothesaurierung as tax instead of a purchase", () => {
  const result = parseBrokerPdfText(`flatexDEGIRO Bank AG\nErtragsmitteilung - thesaurierender transparenter Fonds\nNr.5037861458 INVESCO FTSE ALL-WORLD UC (IE000716YHJ7/A3D7QX)\nSt. : 2.842,99 Bruttothesaurierung\npro Stück : 0,0946 USD\nExtag : 16.06.2026 Bruttothesaurierung : 268,95 USD\nValuta : 17.06.2026 *Einbeh. Steuer : 45,85 EUR\nZuflusstag : 17.06.2026 Devisenkurs : 1,159400\nEndbetrag : -45,85 EUR`, "flatex-steuer.pdf");
  assert.equal(result.transactions.length, 1);
  const transaction = result.transactions[0];
  assert.equal(transaction.type, "tax");
  assert.equal(transaction.isin, "IE000716YHJ7");
  assert.equal(transaction.units, 2842.99);
  assert.equal(transaction.amount, 45.85);
  assert.equal(transaction.currency, "EUR");
  assert.equal(transaction.grossAmount, 268.95);
  assert.equal(transaction.grossCurrency, "USD");
  assert.equal(transaction.taxAmount, 45.85);
  assert.equal(transaction.exchangeRate, 1.1594);
  assert.equal(transaction.date, "2026-06-17");
  assert.equal(holdingDeltaForTransaction(transaction), 0);
});

test("parses a generic dividend credit", () => {
  const result = parseBrokerPdfText(`Trade Republic\nDividendengutschrift\nVanguard FTSE All-World UCITS ETF\nISIN IE00BK5BQT80\nStück 10\nValuta 15.03.2026\nBruttobetrag 14,00 EUR\nQuellensteuer 1,66 EUR\nGutschrift 12,34 EUR`, "dividend.pdf");
  const transaction = result.transactions[0];
  assert.equal(transaction.type, "dividend");
  assert.equal(transaction.isin, "IE00BK5BQT80");
  assert.equal(transaction.units, 10);
  assert.equal(transaction.amount, 12.34);
  assert.equal(transaction.taxAmount, 1.66);
});

test("parses multiple securities from a Baader/Scalable depot delivery", () => {
  const result = parseBrokerPdfText(`Scalable Capital GmbH\nBaader Bank Aktiengesellschaft\nDepoteinlieferung\nNominale ISIN: IE00BL25JL35 WKN: A1103D\nSTK 1 Xtr.(IE) - MSCI World Quality\nVerwahrart: Wertpapierrechnung Handelstag: 20.01.2023\nLagerstelle: 1419 Valuta: 25.01.2023\nNominale ISIN: IE00BL25JM42 WKN: A1103E\nSTK 2,5 Xtr.(IE) - MSCI World Value\nVerwahrart: Wertpapierrechnung Handelstag: 20.01.2023\nLagerstelle: 1419 Valuta: 25.01.2023`, "einlieferung.pdf");
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions.map((transaction) => [transaction.type, transaction.isin, transaction.units]), [
    ["delivery_in", "IE00BL25JL35", 1],
    ["delivery_in", "IE00BL25JM42", 2.5],
  ]);
});

test("supports standalone fee refunds without an ISIN", () => {
  const result = parseBrokerPdfText(`DADAT\nGebührenerstattung\nDatum 01.02.2026\nGutschrift 5,00 EUR`, "gebuehr.pdf");
  const transaction = result.transactions[0];
  assert.equal(transaction.type, "fee_refund");
  assert.equal(transaction.isin, null);
  assert.equal(transaction.units, null);
  assert.equal(transaction.amount, 5);
  assert.equal(transaction.feeAmount, 5);
});

test("handles German thousands and decimal separators without losing units", () => {
  assert.equal(parseLocaleNumber("2.842,99"), 2842.99);
  assert.equal(parseLocaleNumber("1.000"), 1000);
  assert.equal(parseLocaleNumber("19,334524"), 19.334524);
  assert.equal(parseLocaleNumber("325.00"), 325);
});

test("holdings include depot deliveries but ignore dividends, tax and fees", () => {
  const base = { sourceId: "x", sourceFile: "x.pdf", importedAt: "2026-01-01T00:00:00Z", broker: null, securityName: null, amount: null, currency: null, confidence: "medium" as const, evidence: "test" };
  const transactions: BrokerTransaction[] = [
    { ...base, id: "1", type: "buy", isin: "IE00BK5BQT80", date: "2023-01-02", units: 10 },
    { ...base, id: "2", type: "delivery_in", isin: "IE00BK5BQT80", date: "2024-01-02", units: 5 },
    { ...base, id: "3", type: "dividend", isin: "IE00BK5BQT80", date: "2024-06-02", units: 15, amount: 20, currency: "EUR" },
    { ...base, id: "4", type: "tax", isin: "IE00BK5BQT80", date: "2024-07-02", units: 15, amount: 4, currency: "EUR" },
    { ...base, id: "5", type: "sell", isin: "IE00BK5BQT80", date: "2025-02-02", units: 4 },
    { ...base, id: "6", type: "fee", isin: null, date: "2025-03-02", units: null, amount: 2, currency: "EUR" },
  ];
  assert.deepEqual(unitsAtDate(transactions, "IE00BK5BQT80", "2024-12-31"), { units: 15, matchedTransactions: 2 });
  assert.equal(currentUnitsByIsin(transactions)[0].units, 11);
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
