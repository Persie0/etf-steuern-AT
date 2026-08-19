import assert from "node:assert/strict";
import test from "node:test";
import { parseAustrianNumber, parseOekbTextLocally } from "../lib/oekb-extractor.ts";

test("parses Austrian and international decimal formats", () => {
  assert.equal(parseAustrianNumber("1.234,5678"), 1234.5678);
  assert.equal(parseAustrianNumber("0,1275"), 0.1275);
  assert.equal(parseAustrianNumber("-0.052"), -0.052);
});

test("extracts clearly labelled OeKB fields without AI", () => {
  const result = parseOekbTextLocally(`
    ISIN IE00B4L5Y983
    Fondswährung USD
    Meldedatum 15.01.2025
    EUR-Umrechnungskurs 0,971234 EUR / FW
    Tatsächliche Ausschüttung je Anteil 1,2500
    Ausschüttungsgleiche Erträge je Anteil 2,5000
    Anrechenbare Quellensteuer je Anteil 0,1250
    Korrektur Anschaffungskosten je Anteil -0,3500
  `);
  assert.equal(result.isin, "IE00B4L5Y983");
  assert.equal(result.currency, "USD");
  assert.equal(result.reportDate, "2025-01-15");
  assert.equal(result.eurRate, 0.971234);
  assert.equal(result.actualDistributionPerUnit, 1.25);
  assert.equal(result.deemedIncomePerUnit, 2.5);
  assert.equal(result.creditableForeignTaxPerUnit, 0.125);
  assert.equal(result.costBasisAdjustmentPerUnit, -0.35);
});

test("does not invent values when fields are absent", () => {
  const result = parseOekbTextLocally("ISIN IE00B4L5Y983 – keine Jahresmeldung im Ausschnitt");
  assert.equal(result.deemedIncomePerUnit, null);
  assert.equal(result.creditableForeignTaxPerUnit, null);
  assert.equal(result.eurRate, null);
});

