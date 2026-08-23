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

type LineSpan = { start: number; end: number };
type BrokerDefinition = { broker: string; identifiers: RegExp[] };

const isinPattern = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;
const datePattern = /\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](20\d{2})\b/;
const shortDatePattern = /\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](\d{2})\b/;
const isoDatePattern = /\b(20\d{2})-([01]\d)-([0-3]\d)\b/;
const typePattern = /\b(Wertpapierabrechnung\s+(Kauf|Verkauf)|Wertpapierkauf|Wertpapierverkauf|Kauf|Verkauf|Buy|Sell|Purchase|Sale|Execution\s+(Buy|Sell))\b/i;
const unitsPatterns = [
  /\b(?:Ausgef.hrte St.ckzahl|Executed quantity|Ausgef.hrt|St.ck|Stk\.?|Anzahl|Nominale|Quantity|Shares|Units)\s*[:\-]?\s*([0-9][0-9.'\s]*(?:[,.][0-9]+)?)\s*(?:St\.|Stk\.?|St.ck|Anteile|Shares|Units)?\b/i,
  /\b([0-9][0-9.'\s]*(?:[,.][0-9]+)?)\s*(?:St\.|Stk\.?|St.ck|Anteile|Shares|Units)\b/i,
];
const amountLabels = /(?:Abrechnungsbetrag|Gesamtbetrag|Endbetrag|Total|Amount|Zu Ihren Lasten|Zu Ihren Gunsten)/i;
const currencies = "EUR|USD|CHF|GBP|CAD|AUD|JPY|SEK|NOK|DKK|PLN|CZK|HUF";

const brokerDefinitions: BrokerDefinition[] = [
  {
    broker: "Flatex",
    identifiers: [
      /\bbiw AG\b/i,
      /\bFinTech Group Bank AG\b/i,
      /\bflatex Bank AG\b/i,
      /\bflatexDEGIRO Bank (?:AG|SE)\b/i,
      /\bflatex\b/i,
    ],
  },
  { broker: "Trade Republic", identifiers: [/\bTrade Republic\b/i] },
  { broker: "Scalable Capital", identifiers: [/\bScalable Capital\b/i] },
  { broker: "Baader Bank", identifiers: [/\bBaader Bank\b/i] },
  { broker: "DEGIRO", identifiers: [/\bDEGIRO\b/i] },
  { broker: "Interactive Brokers", identifiers: [/\bInteractive Brokers\b/i, /\bIBKR\b/i] },
  { broker: "DADAT", identifiers: [/\bDADAT\b/i] },
  { broker: "easybank", identifiers: [/\beasybank\b/i] },
];

function normalizeLigatures(value: string): string {
  return value
    .replaceAll("ﬀ", "ff")
    .replaceAll("ﬁ", "fi")
    .replaceAll("ﬂ", "fl")
    .replaceAll("ﬃ", "ffi")
    .replaceAll("ﬄ", "ffl");
}

export function normalizeBrokerPdfText(text: string): string[] {
  return normalizeLigatures(text)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u00ad/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line) => line.length > 0 && line !== "--- Seite ---");
}

export function parseLocaleNumber(raw: string): number | null {
  let compact = raw.trim().replace(/[\s']/g, "");
  compact = compact.replace(/^[+]/, "");
  if (!compact || !/^-?[0-9][0-9.,]*$/.test(compact)) return null;

  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  let normalized = compact;

  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot
      ? compact.replaceAll(".", "").replace(",", ".")
      : compact.replaceAll(",", "");
  } else if (comma >= 0) {
    const parts = compact.split(",");
    normalized = parts.length > 2 && parts.slice(1).every((part) => part.length === 3)
      ? compact.replaceAll(",", "")
      : compact.replace(",", ".");
  } else if (dot >= 0) {
    const unsigned = compact.replace(/^-/, "");
    normalized = /^\d{1,3}(?:\.\d{3})+$/.test(unsigned) ? compact.replaceAll(".", "") : compact;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function normalizeDate(raw: string): string | null {
  const iso = raw.match(isoDatePattern);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = raw.match(datePattern);
  if (local) return `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
  const short = raw.match(shortDatePattern);
  if (!short) return null;
  return `20${short[3]}-${short[2].padStart(2, "0")}-${short[1].padStart(2, "0")}`;
}

function identifyBroker(text: string): BrokerDefinition | null {
  const normalized = normalizeLigatures(text);
  return brokerDefinitions.find((definition) => definition.identifiers.some((pattern) => pattern.test(normalized))) ?? null;
}

function transactionType(value: string): BrokerTransactionType | null {
  if (/Verkauf|Sell|Sale/i.test(value)) return "sell";
  if (/Kauf|Buy|Purchase/i.test(value)) return "buy";
  return null;
}

function splitAtMatches(lines: string[], pattern: RegExp): LineSpan[] {
  const starts = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
  return starts.map((start, index) => ({ start, end: (starts[index + 1] ?? lines.length) - 1 }));
}

function firstMatch(lines: string[], patterns: RegExp[]): RegExpMatchArray | null {
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) return match;
    }
  }
  return null;
}

function pickDate(lines: string[], typeIndex = 0): string | null {
  const dateValue = `(20\\d{2}-[01]\\d-[0-3]\\d|[0-3]?\\d[.\\/-][01]?\\d[.\\/-](?:20)?\\d{2})`;
  const preferred = new RegExp(`(?:Handelstag|Schlusstag|Ausf.hrungstag|Trade date|Execution date)[^\\d]*${dateValue}`, "i");
  const fallbackLabelled = new RegExp(`(?:Gesch.ftsdatum|Orderdatum|Datum|Ausf.hrung)[^\\d]*${dateValue}`, "i");
  for (const pattern of [preferred, fallbackLabelled]) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return normalizeDate(match[1]);
    }
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

function pickUnits(lines: string[], typeIndex = 0): number | null {
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
    if (!amountLabels.test(line)) continue;
    const afterLabel = line.slice(line.search(amountLabels)).replace(amountLabels, "").replace(/^\s*:?\s*/, "");
    const currencyFirst = afterLabel.match(new RegExp(`^(${currencies})\\s*([+\\-]?\\s*[0-9][0-9.'\\s]*(?:[,.][0-9]+)?)`, "i"));
    const amountFirst = afterLabel.match(new RegExp(`^([+\\-]?\\s*[0-9][0-9.'\\s]*(?:[,.][0-9]+)?)\\s*(${currencies})\\b`, "i"));
    const match = currencyFirst ?? amountFirst;
    if (!match) continue;
    const currency = (currencyFirst ? match[1] : match[2]).toUpperCase();
    const rawAmount = currencyFirst ? match[2] : match[1];
    const amount = parseLocaleNumber(rawAmount.replace(/\s/g, ""));
    if (amount !== null) return { amount: Math.abs(amount), currency };
  }
  return null;
}

function pickSecurityName(lines: string[], isinIndex: number, isin: string): string | null {
  if (isinIndex < 0 || !lines[isinIndex]) return null;
  const sameLine = lines[isinIndex]
    .replace(isin, "")
    .replace(/\/[A-Z0-9]{6}\b/, "")
    .replace(/[()]/g, "")
    .replace(/^ISIN\s*:?/i, "")
    .trim();
  if (sameLine.length >= 4 && !/^(WKN|St.ck|Anzahl)/i.test(sameLine)) return sameLine.slice(0, 160);
  const previous = lines[isinIndex - 1]?.trim();
  if (previous && previous.length >= 4 && !typePattern.test(previous)) return previous.slice(0, 160);
  return null;
}

function buildDraft(sourceFile: string, broker: string | null, lines: string[], type: BrokerTransactionType, isin: string, units: number, date: string, securityName: string | null): BrokerTransactionDraft {
  const amount = pickAmount(lines);
  const confidence: ImportConfidence = broker && amount ? "high" : broker ? "medium" : "low";
  return {
    sourceFile,
    broker,
    type,
    isin,
    securityName,
    date,
    units,
    amount: amount?.amount ?? null,
    currency: amount?.currency ?? null,
    confidence,
    evidence: lines.join(" | ").slice(0, 700),
  };
}

function parseFlatexBuySell(lines: string[], sourceFile: string): BrokerTransactionDraft[] {
  const titleStarts = splitAtMatches(lines, /\bWertpapierabrechnung\s+(?:Kauf|Verkauf)(?:\s+Fonds\/Zertifikate)?\b/i);
  const orderStarts = splitAtMatches(lines, /^Nr\.\s*\d+(?:\/\d+)?\s+(?:Kauf|Verkauf)\b/i);
  const spans = titleStarts.length > 0 ? titleStarts : orderStarts.length > 0 ? orderStarts : [{ start: 0, end: lines.length - 1 }];
  const transactions: BrokerTransactionDraft[] = [];

  for (const span of spans) {
    const block = lines.slice(span.start, span.end + 1);
    const blockText = block.join("\n");
    if (!/\b(?:Wertpapierabrechnung\s+)?(?:Kauf|Verkauf)\b/i.test(blockText)) continue;
    if (/\b(?:Storno|Stornierung)\s+Wertpapierabrechnung\b/i.test(blockText)) continue;

    const type = transactionType(blockText);
    const order = firstMatch(block, [
      /^Nr\.\s*\d+(?:\/\d+)?\s+(?:Kauf|Verkauf)\s+(.+?)\s+\(([A-Z]{2}[A-Z0-9]{9}[0-9])(?:\/[A-Z0-9]{6})?\)\s*$/i,
      /^(?:Kauf|Verkauf)\s+(.+?)\s+\(([A-Z]{2}[A-Z0-9]{9}[0-9])(?:\/[A-Z0-9]{6})?\)\s*$/i,
    ]);
    const isinIndex = block.findIndex((line) => isinPattern.test(line));
    const isin = order?.[2] ?? (isinIndex >= 0 ? block[isinIndex].match(isinPattern)?.[0] ?? null : null);
    const units = pickUnits(block, 0);
    const date = pickDate(block, 0);
    if (!type || !isin || units === null || !date) continue;
    const securityName = order?.[1]?.trim().slice(0, 160) ?? pickSecurityName(block, isinIndex, isin);
    transactions.push(buildDraft(sourceFile, "Flatex", block, type, isin, units, date, securityName));
  }

  return transactions;
}

function parseGenericBuySell(lines: string[], sourceFile: string, broker: string | null): BrokerTransactionDraft[] {
  const typeIndexes = lines.flatMap((line, index) => typePattern.test(line) ? [index] : []);
  const candidates: BrokerTransactionDraft[] = [];

  for (const typeIndex of typeIndexes) {
    const start = Math.max(0, typeIndex - 12);
    const end = Math.min(lines.length, typeIndex + 48);
    const block = lines.slice(start, end);
    const localTypeIndex = typeIndex - start;
    const type = transactionType(lines[typeIndex]);
    const nearestIsins = block.flatMap((line, index) => isinPattern.test(line) ? [{ index, distance: Math.abs(index - localTypeIndex), isin: line.match(isinPattern)![0] }] : []);
    nearestIsins.sort((a, b) => a.distance - b.distance);
    const isinMatch = nearestIsins[0];
    const units = pickUnits(block, localTypeIndex);
    const date = pickDate(block, localTypeIndex);
    if (!type || !isinMatch || units === null || !date) continue;
    const securityName = pickSecurityName(block, isinMatch.index, isinMatch.isin);
    candidates.push(buildDraft(sourceFile, broker, block, type, isinMatch.isin, units, date, securityName));
  }

  return candidates;
}

function deduplicateTransactions(candidates: BrokerTransactionDraft[]): BrokerTransactionDraft[] {
  const unique = new Map<string, BrokerTransactionDraft>();
  for (const candidate of candidates) {
    const key = `${candidate.type}|${candidate.isin}|${candidate.date}|${candidate.units}|${candidate.amount ?? ""}|${candidate.currency ?? ""}`;
    const existing = unique.get(key);
    if (!existing || confidenceRank(candidate.confidence) > confidenceRank(existing.confidence)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function confidenceRank(confidence: ImportConfidence): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

export function parseBrokerPdfText(text: string, sourceFile: string): BrokerPdfParseResult {
  const lines = normalizeBrokerPdfText(text);
  const definition = identifyBroker(text);
  const broker = definition?.broker ?? null;
  const warnings: string[] = [];

  const specialized = broker === "Flatex" ? parseFlatexBuySell(lines, sourceFile) : [];
  const generic = specialized.length > 0 ? [] : parseGenericBuySell(lines, sourceFile, broker);
  const transactions = deduplicateTransactions([...specialized, ...generic]);

  if (transactions.length === 0) {
    warnings.push("Keine vollständige Kauf- oder Verkaufstransaktion erkannt. Wie bei Portfolio Performance wird nur importiert, wenn Dokumenttyp, ISIN, Datum und Stückzahl zusammenpassen.");
    if (broker) warnings.push(`${broker} wurde erkannt, das konkrete Dokumentlayout ist aber noch nicht als Kauf/Verkauf unterstützt.`);
  }
  if (!broker) warnings.push("Broker nicht eindeutig erkannt; die gefundenen Werte besonders sorgfältig prüfen.");
  if (transactions.some((transaction) => transaction.confidence !== "high")) warnings.push("Mindestens eine Transaktion wurde ohne eindeutig erkannten End-/Abrechnungsbetrag importiert und sollte kontrolliert werden.");
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
