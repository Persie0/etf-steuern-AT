import type { BrokerTransaction, BrokerTransactionType } from "./broker-transactions";

export const backupFormat = "etf-steuerassistent-at" as const;
export const backupVersion = 1 as const;

export type AppBackup<TPortfolio = unknown, TValues = unknown> = {
  format: typeof backupFormat;
  version: typeof backupVersion;
  exportedAt: string;
  data: {
    identifier: string;
    taxYear: string;
    status: "reporting" | "non-reporting";
    values: TValues;
    ownershipStatus: "held" | "sold";
    portfolio: TPortfolio[];
    activePositionId: string | null;
    showSale: boolean;
    saleCurrency: "EUR" | "USD";
    saleDate: string;
    transactions: BrokerTransaction[];
  };
};

export function createAppBackup<TPortfolio, TValues>(data: AppBackup<TPortfolio, TValues>["data"]): string {
  return JSON.stringify({ format: backupFormat, version: backupVersion, exportedAt: new Date().toISOString(), data }, null, 2);
}

const transactionTypes = new Set<BrokerTransactionType>([
  "buy", "sell", "dividend", "tax", "tax_refund", "fee", "fee_refund", "delivery_in", "delivery_out",
]);
const holdingTypes = new Set<BrokerTransactionType>(["buy", "sell", "delivery_in", "delivery_out"]);

function validNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
}

function validTransaction(value: unknown): value is BrokerTransaction {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BrokerTransaction>;
  if (typeof item.id !== "string" || typeof item.sourceId !== "string" || typeof item.sourceFile !== "string") return false;
  if (!transactionTypes.has(item.type as BrokerTransactionType)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? "")) return false;
  if (item.isin !== null && item.isin !== undefined && !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(item.isin)) return false;
  if (!validNullableNumber(item.units) || (typeof item.units === "number" && item.units < 0)) return false;
  if (!validNullableNumber(item.amount) || !validNullableNumber(item.grossAmount) || !validNullableNumber(item.taxAmount) || !validNullableNumber(item.feeAmount) || !validNullableNumber(item.exchangeRate)) return false;
  if (holdingTypes.has(item.type as BrokerTransactionType)) {
    if (!item.isin || typeof item.units !== "number" || item.units <= 0) return false;
  }
  return true;
}

export function parseAppBackup<TPortfolio = unknown, TValues = unknown>(raw: string): AppBackup<TPortfolio, TValues> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Die Datei enthält kein gültiges JSON."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Ungültige Backup-Datei.");
  const backup = parsed as Partial<AppBackup<TPortfolio, TValues>>;
  if (backup.format !== backupFormat || backup.version !== backupVersion || !backup.data || typeof backup.data !== "object") {
    throw new Error("Dieses Backup-Format wird nicht unterstützt.");
  }
  const data = backup.data as AppBackup<TPortfolio, TValues>["data"];
  if (!Array.isArray(data.portfolio) || !Array.isArray(data.transactions) || !data.transactions.every(validTransaction)) {
    throw new Error("Portfolio oder Transaktionen im Backup sind beschädigt.");
  }
  if (typeof data.identifier !== "string" || typeof data.taxYear !== "string" || !data.values || typeof data.values !== "object") {
    throw new Error("Dem Backup fehlen erforderliche Rechnerdaten.");
  }
  return backup as AppBackup<TPortfolio, TValues>;
}
