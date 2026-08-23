import assert from "node:assert/strict";
import test from "node:test";
import { createAppBackup, parseAppBackup } from "../lib/app-backup.ts";

const data = {
  identifier: "IE00BK5BQT80",
  taxYear: "2025",
  status: "reporting" as const,
  values: { units: 10 },
  ownershipStatus: "held" as const,
  portfolio: [{ id: "p1" }],
  activePositionId: "p1",
  showSale: false,
  saleCurrency: "EUR" as const,
  saleDate: "",
  transactions: [
    { id: "t1", sourceId: "s1", sourceFile: "trade.pdf", importedAt: "2025-01-01T00:00:00Z", broker: "Test", type: "buy" as const, isin: "IE00BK5BQT80", securityName: "ETF", date: "2024-01-01", units: 10, amount: 1000, currency: "EUR", confidence: "high" as const, evidence: "Kauf" },
    { id: "t2", sourceId: "s2", sourceFile: "fee.pdf", importedAt: "2025-01-02T00:00:00Z", broker: "Test", type: "fee_refund" as const, isin: null, securityName: null, date: "2024-01-02", units: null, amount: 5, currency: "EUR", feeAmount: 5, confidence: "high" as const, evidence: "Gebührenerstattung" },
  ],
};

test("round-trips the full local application backup with extended broker events", () => {
  const parsed = parseAppBackup(createAppBackup(data));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.version, 1);
});

test("keeps old version-1 buy/sell backups compatible", () => {
  const legacy = { ...data, transactions: [data.transactions[0]] };
  const parsed = parseAppBackup(createAppBackup(legacy));
  assert.equal(parsed.data.transactions[0].type, "buy");
});

test("rejects malformed holding transactions and unrelated backup files", () => {
  const broken = JSON.parse(createAppBackup(data));
  broken.data.transactions[0].units = null;
  assert.throws(() => parseAppBackup(JSON.stringify(broken)), /beschädigt/);
  assert.throws(() => parseAppBackup('{"format":"other"}'), /nicht unterstützt/);
  assert.throws(() => parseAppBackup("not json"), /gültiges JSON/);
});
