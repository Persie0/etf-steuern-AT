import assert from "node:assert/strict";
import test from "node:test";
import { createAppBackup, parseAppBackup } from "../lib/app-backup.ts";

const data = { identifier: "IE00BK5BQT80", taxYear: "2025", status: "reporting" as const, values: { units: 10 }, ownershipStatus: "held" as const, portfolio: [{ id: "p1" }], activePositionId: "p1", showSale: false, saleCurrency: "EUR" as const, saleDate: "", transactions: [{ id: "t1", sourceId: "s1", sourceFile: "trade.pdf", importedAt: "2025-01-01T00:00:00Z", broker: "Test", type: "buy" as const, isin: "IE00BK5BQT80", securityName: "ETF", date: "2024-01-01", units: 10, amount: 1000, currency: "EUR", confidence: "high" as const, evidence: "Kauf" }] };

test("round-trips the full local application backup", () => {
  const parsed = parseAppBackup(createAppBackup(data));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.version, 1);
});

test("rejects unrelated or damaged backup files", () => {
  assert.throws(() => parseAppBackup('{"format":"other"}'), /nicht unterstützt/);
  assert.throws(() => parseAppBackup("not json"), /gültiges JSON/);
});
