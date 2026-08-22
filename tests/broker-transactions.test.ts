import assert from "node:assert/strict";
import test from "node:test";
import { currentUnitsByIsin, parseBrokerPdfText, unitsAtDate } from "../lib/broker-transactions.ts";
import type { BrokerTransaction } from "../lib/broker-transactions.ts";

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
