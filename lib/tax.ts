export type FundStatus = "reporting" | "non-reporting";

export type TaxInput = {
  status: FundStatus;
  units: number;
  eurRate: number;
  distributionsPerUnit: number;
  deemedIncomePerUnit: number;
  creditableTaxPerUnit: number;
  costAdjustmentPerUnit: number;
  saleProceeds: number;
  saleCostBasis: number;
  saleFees: number;
  openingPricePerUnit: number;
  closingPricePerUnit: number;
};

export type TaxResult = {
  kz898: number;
  kz937: number;
  kz994: number;
  kz892: number;
  kz998: number;
  taxableTotal: number;
  estimatedTax: number;
  costAdjustment: number;
  nonReportingLumpSum: number;
};

const positive = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);
const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateEtfTax(input: TaxInput): TaxResult {
  const units = positive(input.units);
  const rate = positive(input.eurRate) || 1;
  const distributions = positive(input.distributionsPerUnit) * units * rate;
  const creditedTax = input.status === "reporting" ? positive(input.creditableTaxPerUnit) * units * rate : 0;
  const saleResult = input.saleProceeds - input.saleCostBasis - input.saleFees;

  let deemedIncome = positive(input.deemedIncomePerUnit) * units * rate;
  let nonReportingLumpSum = 0;

  if (input.status === "non-reporting") {
    const annualIncrease = positive(input.closingPricePerUnit - input.openingPricePerUnit) * units;
    const minimum = positive(input.closingPricePerUnit) * units * 0.1;
    nonReportingLumpSum = Math.max(annualIncrease * 0.9, minimum);
    deemedIncome = nonReportingLumpSum;
  }

  const gain = positive(saleResult);
  const loss = positive(-saleResult);
  const taxableTotal = positive(distributions + deemedIncome + gain - loss);
  const credit = Math.min(creditedTax, taxableTotal * 0.275);

  return {
    kz898: rounded(distributions),
    kz937: rounded(deemedIncome),
    kz994: rounded(gain),
    kz892: rounded(loss),
    kz998: rounded(credit),
    taxableTotal: rounded(taxableTotal),
    estimatedTax: rounded(positive(taxableTotal * 0.275 - credit)),
    costAdjustment: input.status === "reporting" ? rounded(input.costAdjustmentPerUnit * units * rate) : 0,
    nonReportingLumpSum: rounded(nonReportingLumpSum),
  };
}
