import assert from "node:assert/strict";
import test from "node:test";
import { calculateCorrectedCostBasis, calculateEtfTax } from "../lib/tax.ts";
import { parseEditableNumber } from "../lib/editable-number.ts";

const base = {
  status: "reporting" as const,
  units: 10,
  eurRate: 1,
  distributionsPerUnit: 1,
  deemedIncomePerUnit: 2,
  creditableTaxPerUnit: 0.1,
  costAdjustmentPerUnit: 3,
  saleProceeds: 0,
  saleCostBasis: 0,
  saleFees: 0,
  openingPricePerUnit: 0,
  closingPricePerUnit: 0,
};

test("maps reporting-fund values to E1kv codes", () => {
  const result = calculateEtfTax(base);
  assert.deepEqual({ kz898: result.kz898, kz937: result.kz937, kz998: result.kz998 }, { kz898: 10, kz937: 20, kz998: 1 });
  assert.equal(result.taxableTotal, 30);
  assert.equal(result.estimatedTax, 7.25);
  assert.equal(result.costAdjustment, 30);
});

test("converts per-unit foreign-currency values once", () => {
  const result = calculateEtfTax({ ...base, eurRate: 0.9 });
  assert.equal(result.kz898, 9);
  assert.equal(result.kz937, 18);
  assert.equal(result.costAdjustment, 27);
});

test("uses the higher non-reporting-fund lump sum", () => {
  const result = calculateEtfTax({ ...base, status: "non-reporting", distributionsPerUnit: 1, openingPricePerUnit: 100, closingPricePerUnit: 110 });
  assert.equal(result.nonReportingLumpSum, 110);
  assert.equal(result.taxableTotal, 120);
  assert.equal(result.estimatedTax, 33);
});

test("separates sale gains and losses", () => {
  const gain = calculateEtfTax({ ...base, saleProceeds: 1000, saleCostBasis: 800, saleFees: 10 });
  assert.equal(gain.kz994, 190);
  assert.equal(gain.kz892, 0);
  const loss = calculateEtfTax({ ...base, saleProceeds: 700, saleCostBasis: 800, saleFees: 10 });
  assert.equal(loss.kz994, 0);
  assert.equal(loss.kz892, 110);
});

test("converts USD sale proceeds and fees with the sale-date EUR rate", () => {
  const result = calculateEtfTax({ ...base, distributionsPerUnit: 0, deemedIncomePerUnit: 0, creditableTaxPerUnit: 0, saleProceeds: 1000, saleCostBasis: 700, saleFees: 10, saleFxRate: 0.9 });
  assert.equal(result.kz994, 191);
  assert.equal(result.kz892, 0);
});

test("carries OeKB acquisition-cost corrections forward only through the sale date", () => {
  const ledger = calculateCorrectedCostBasis(1000, [
    { taxYear: "2024", reportDate: "2024-06-10", amount: 40 },
    { taxYear: "2025", reportDate: "2025-06-12", amount: -10 },
    { taxYear: "2026", reportDate: "2026-06-11", amount: 25 },
  ], "2025-12-31");
  assert.equal(ledger.totalCorrection, 30);
  assert.equal(ledger.correctedCostBasis, 1030);
  assert.equal(ledger.eligibleCorrections.length, 2);
  assert.equal(ledger.excludedCorrections.length, 1);
});

test("allows an empty number field before entering a value without a leading zero", () => {
  assert.equal(parseEditableNumber(""), 0);
  assert.equal(parseEditableNumber("12.5"), 12.5);
  assert.equal(parseEditableNumber("12,5"), 12.5);
});
