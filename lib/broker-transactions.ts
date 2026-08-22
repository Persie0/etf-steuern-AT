export type BrokerTransactionType = "buy" | "sell";
export type ImportConfidence = "high" | "medium" | "low";

export type BrokerTransaction = {
  id: string;
  sourceId: string;
  sourceFile: string;
  importedAt: string;
  broker: string | null;
  type: BrokerTransactionType;
  isin: string;
  securityName: string | null;
  date: string;
  units: number;
  amount: number | null;
  currency: string | null;
  confidence: ImportConfidence;
  evidence: string;
};

export type BrokerTransactionDraft = Omit<BrokerTransaction, "id" | "sourceId" | "importedAt">;

export type BrokerPdfParseResult = {
  broker: string | null;
  transactions: BrokerTransactionDraft[];
  warnings: string[];
};

const isinPattern = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;
const datePattern = /\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](20\d{2})\b/;
const isoDatePattern = /\b(20\d{2})-([01]\d)-([0-3]\d)\b/;
const typePattern = /\b(Wertpapierabrechnung\s+(Kauf|Verkauf)|Wertpapierkauf|Wertpapierverkauf|Kauf|Verkauf|Buy|Sell|Purchase|Sale|Execution\s+(Buy|Sell))\b/i;
const unitsPatterns = [
  /\b(?:St.ck|Stk\.?|Anzahl|Nominale|Quantity|Shares|Units)\s*[:\-]?\s*([0-9][0-9.'\s]*(?:[,.][0-9]+)?)/i,
  /\b([0-9][0-9.'\s]*(?:[,.][0-9]+)?)\s*(?:St.ck|Stk\.?|Anteile|Shares|Units)\b/i,
  /\b(?:Ausgef.hrte St.ckzahl|Executed quantity)\s*[:\-]?\s*([0-9][0-9.'\s]*(?:[,.][0-9]+)?)/i,
];
const amountPatterns = [
  /\b(?:Abrechnungsbetrag|Gesamtbetrag|Endbetrag|Total|Amount)\s*[:\-]?\s*[+\-]?\s*([0-9][0-9.'\s]*(?:[,.][0-9]{2}))\s*(EUR|USD|CHF|GBP)\b/i,
  /\b(?:Zu Ihren Lasten|Zu Ihren Gunsten)\s*[+\-]?\s*([0-9][0-9.'\s]*(?:[,.][0-9]{2}))\s*(EUR|USD|CHF|GBP)\b/i,
];

export function parseLocaleNumber(raw: string): number | null {
  const compact = raw.replace(/[\s']/g, "");
  if (!compact) return null;
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  let normalized = compact;
  if (comma > dot) normalized = compact.replaceAll(".", "").replace(",", ".");
  else if (dot > comma && comma >= 0) normalized = compact.replaceAll(",", "");
  else if (comma >= 0) normalized = compact.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function normalizeDate(raw: string): string | null {
  const iso = raw.match(isoDatePattern);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = raw.match(datePattern);
  if (!local) return null;
  return `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
}

function identifyBroker(text: string): string | null {
  const brokers: Array<[RegExp, string]> = [
    [/Trade Republic/i, "Trade Republic"],
    [/Scalable Capital/i, "Scalable Capital"],
    [/Baader Bank/i, "Baader Bank"],
    [/flatex/i, "Flatex"],
    [/DEGIRO/i, "DEGIRO"],
    [/Interactive Brokers|IBKR/i, "Interactive Brokers"],
    [/DADAT/i, "DADAT"],
    [/easybank/i, "easybank"],
  ];
  return brokers.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function transactionType(value: string): BrokerTransactionType | null {
  if (/Verkauf|Sell|Sale/i.test(value)) return "sell";
  if (/Kauf|Buy|Purchase/i.test(value)) return "buy";
  return null;
}

function pickDate(lines: string[], typeIndex: number): string | null {
  const labelled = /(?:Handelstag|Schlusstag|Ausf.hrungstag|Ausf.hrung|Gesch.ftsdatum|Orderdatum|Datum|Trade date|Execution date)[^\d]*(20\d{2}-[01]\d-[0-3]\d|[0-3]?\d[.\/-][01]?\d[.\/-]20\d{2})/i;
  for (const line of lines) {
    const match = line.match(labelled);
    if (match) return normalizeDate(match[1]);
  }
  for (let distance = 0; distance < lines.length; distance += 1) {
    for (const index of [typeIndex + distance, typeIndex - distance]) {
      if (index < 0 || index >= lines.length) continue;
      const date = normalizeDate(lines[index]);
      if (date) return date;
    }
  }
  return null;
}

function pickUnits(lines: string[], typeIndex: number): number | null {
  for (let distance = 0; distance < lines.length; distance += 1) {
    for (const index of [typeIndex + distance, typeIndex - distance]) {
      if (index < 0 || index >= lines.length) continue;
      for (const pattern of unitsPatterns) {
        const match = lines[index].match(pattern);
        const value = match ? parseLocaleNumber(match[1]) : null;
        if (value !== null && value > 0) return value;
      }
    }
  }
  return null;
}

function pickAmount(lines: string[]): { amount: number; currency: string } | null {
  for (const line of lines) {
    for (const pattern of amountPatterns) {
      const match = line.match(pattern);
      const amount = match ? parseLocaleNumber(match[1]) : null;
      if (amount !== null) return { amount: Math.abs(amount), currency: match![2].toUpperCase() };
    }
  }
  return null;
}

function pickSecurityName(lines: string[], isinIndex: number, isin: string): string | null {
  if (isinIndex < 0 || !lines[isinIndex]) return null;
  const sameLine = lines[isinIndex].replace(isin, "").replace(/[()]/g, "").trim();
  if (sameLine.length >= 4 && !/^(ISIN|WKN|St.ck|Anzahl)/i.test(sameLine)) return sameLine.slice(0, 160);
  const previous = lines[isinIndex - 1]?.trim();
  if (previous && previous.length >= 4 && !typePattern.test(previous)) return previous.slice(0, 160);
  return null;
}

export function parseBrokerPdfText(text: string, sourceFile: string): BrokerPdfParseResult {
  const lines = text.replace(/\u00a0/g, " ").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const broker = identifyBroker(text);
  const warnings: string[] = [];
  const candidates: BrokerTransactionDraft[] = [];
  const typeIndexes = lines.flatMap((line, index) => typePattern.test(line) ? [index] : []);

  for (const typeIndex of typeIndexes.length ? typeIndexes : [0]) {
    const start = Math.max(0, typeIndex - 10);
    const end = Math.min(lines.length, typeIndex + 35);
    const windowLines = lines.slice(start, end);
    const localTypeIndex = Math.min(typeIndex - start, windowLines.length - 1);
    const type = transactionType(lines[typeIndex] ?? text);
    const isinIndex = windowLines.findIndex((line) => isinPattern.test(line));
    const isin = isinIndex >= 0 ? windowLines[isinIndex].match(isinPattern)?.[0] ?? null : text.match(isinPattern)?.[0] ?? null;
    const units = pickUnits(windowLines, localTypeIndex);
    const date = pickDate(windowLines, localTypeIndex);
    if (!type || !isin || units === null || !date) continue;
    const amount = pickAmount(windowLines);
    const evidence = windowLines.slice(Math.max(0, localTypeIndex - 2), Math.min(windowLines.length, localTypeIndex + 8)).join(" | ").slice(0, 500);
    const securityName = pickSecurityName(windowLines, isinIndex, isin);
    const confidence: ImportConfidence = amount && broker ? "high" : broker ? "medium" : "low";
    candidates.push({ sourceFile, broker, type, isin, securityName, date, units, amount: amount?.amount ?? null, currency: amount?.currency ?? null, confidence, evidence });
  }

  const unique = new Map<string, BrokerTransactionDraft>();
  for (const candidate of candidates) unique.set(`${candidate.type}|${candidate.isin}|${candidate.date}|${candidate.units}`, candidate);
  const transactions = [...unique.values()];
  if (transactions.length === 0) warnings.push("Keine vollständige Kauf- oder Verkaufstransaktion erkannt. Benötigt werden Transaktionsart, ISIN, Datum und Stückzahl.");
  if (!broker) warnings.push("Broker nicht eindeutig erkannt; die gefundenen Werte besonders sorgfältig prüfen.");
  if (transactions.some((transaction) => transaction.confidence !== "high")) warnings.push("Mindestens eine Transaktion wurde nur mit mittlerer oder niedriger Sicherheit erkannt.");
  return { broker, transactions, warnings };
}

export function unitsAtDate(transactions: BrokerTransaction[], isin: string, cutoffDate: string): { units: number; matchedTransactions: number } {
  const normalized = isin.trim().toUpperCase();
  const eligible = transactions.filter((transaction) => transaction.isin === normalized && transaction.date <= cutoffDate);
  const units = eligible.reduce((sum, transaction) => sum + (transaction.type === "buy" ? transaction.units : -transaction.units), 0);
  return { units: Math.round((units + Number.EPSILON) * 1e8) / 1e8, matchedTransactions: eligible.length };
}

export function currentUnitsByIsin(transactions: BrokerTransaction[]): Array<{ isin: string; units: number; transactions: number }> {
  const grouped = new Map<string, BrokerTransaction[]>();
  for (const transaction of transactions) grouped.set(transaction.isin, [...(grouped.get(transaction.isin) ?? []), transaction]);
  return [...grouped.entries()].map(([isin, entries]) => ({
    isin,
    units: Math.round((entries.reduce((sum, entry) => sum + (entry.type === "buy" ? entry.units : -entry.units), 0) + Number.EPSILON) * 1e8) / 1e8,
    transactions: entries.length,
  })).sort((a, b) => a.isin.localeCompare(b.isin));
}
