import assert from "node:assert/strict";
import test from "node:test";
import { selectLatestHeldPositions } from "../lib/portfolio.ts";

test("shows only the newest current holding per ISIN", () => {
  const holdings = selectLatestHeldPositions([
    { identifier: "ETF-A", taxYear: "2024", savedAt: "2024-02-01", ownershipStatus: "held" as const, units: 10 },
    { identifier: "ETF-A", taxYear: "2025", savedAt: "2025-02-01", ownershipStatus: "held" as const, units: 12 },
    { identifier: "ETF-B", taxYear: "2025", savedAt: "2025-03-01", ownershipStatus: "held" as const, units: 4 },
  ]);
  assert.deepEqual(holdings.map((entry) => [entry.identifier, entry.units]), [["ETF-A", 12], ["ETF-B", 4]]);
});

test("does not show an ETF whose newest position is sold", () => {
  const holdings = selectLatestHeldPositions([
    { identifier: "ETF-A", taxYear: "2025", savedAt: "2025-02-01", ownershipStatus: "held" as const },
    { identifier: "ETF-A", taxYear: "2026", savedAt: "2026-02-01", ownershipStatus: "sold" as const },
  ]);
  assert.deepEqual(holdings, []);
});
