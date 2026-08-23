import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { buildPortfolioWorkbook } from "../lib/xlsx-export.ts";
import type { BrokerTransaction } from "../lib/broker-transactions.ts";

test("creates an Excel workbook with summary, ETF and extended transaction sheets", () => {
  const transactions: BrokerTransaction[] = [
    { id: "t1", sourceId: "s1", sourceFile: "dividend.pdf", importedAt: "2025-01-15T00:00:00Z", broker: "Flatex", type: "dividend", isin: "IE00BK5BQT80", securityName: "Vanguard ETF", date: "2025-01-15", units: 10, amount: 12.34, currency: "EUR", grossAmount: 14, grossCurrency: "EUR", taxAmount: 1.66, feeAmount: null, exchangeRate: null, confidence: "high", evidence: "test" },
  ];
  const bytes = buildPortfolioWorkbook([{ identifier: "IE00BK5BQT80", taxYear: "2025", status: "reporting", ownershipStatus: "held", savedAt: "2025-01-15T00:00:00Z", values: { units: 10, eurRate: 0.97 }, security: { name: "Vanguard ETF" }, result: { kz898: 0, kz937: 20.25, kz994: 0, kz892: 0, kz998: 1.86, taxableTotal: 20.25, estimatedTax: 3.71, costAdjustment: 17.84 } }], transactions);
  assert.equal(bytes[0], 0x50);
  const files = unzipSync(bytes);
  assert.ok(files["xl/workbook.xml"]);
  assert.match(strFromU8(files["xl/workbook.xml"]), /ETF-Jahresdaten/);
  assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]), /IE00BK5BQT80/);
  assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]), /Vanguard ETF/);
  const transactionSheet = strFromU8(files["xl/worksheets/sheet3.xml"]);
  assert.match(transactionSheet, /Dividende/);
  assert.match(transactionSheet, /Brutto-Betrag/);
  assert.match(transactionSheet, />1\.66</);
});
