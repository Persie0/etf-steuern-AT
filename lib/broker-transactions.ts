export type BrokerTransactionType = "buy" | "sell" | "dividend" | "tax" | "tax_refund" | "fee" | "fee_refund" | "delivery_in" | "delivery_out";
export type ImportConfidence = "high" | "medium" | "low";

export type BrokerTransaction = {
  id: string;
  sourceId: string;
  sourceFile: string;
  importedAt: string;
  broker: string | null;
  type: BrokerTransactionType;
  isin: string | null;
  securityName: string | null;
  date: string;
  units: number | null;
  amount: number | null;
  currency: string | null;
  grossAmount?: number | null;
  grossCurrency?: string | null;
  taxAmount?: number | null;
  feeAmount?: number | null;
  exchangeRate?: number | null;
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
type MoneyValue = { amount: number; currency: string; raw: number };

const isinPattern = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;
const datePattern = /\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](20\d{2})\b/;
const shortDatePattern = /\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](\d{2})\b/;
const isoDatePattern = /\b(20\d{2})-([01]\d)-([0-3]\d)\b/;
const buySellPattern = /(Wertpapierabrechnung\s+(Kauf|Verkauf)|Wertpapierkauf|Wertpapierverkauf|\bKauf\b|\bVerkauf\b|\bBuy\b|\bSell\b|\bPurchase\b|\bSale\b|Execution\s+(Buy|Sell)|Market-Order\s*(?:Buy|Sell|Achat|Vente|Acquisto|Vendita|Compra|Venta|Kopen|Verkoop)|\bAchat\b|\bVente\b|\bAcquisto\b|\bVendita\b|\bCompra\b|\bVenta\b|\bKopen\b|\bVerkoop\b|Sparplanausf.hrung|Round\s*up|investissement programm.|piano di accumulo|Saveback)/i;
const dividendDocumentPattern = /\b(Ertragsmitteilung|Dividendengutschrift|Dividendenabrechnung|Dividende|Aussch.ttung|Ertragsgutschrift|Dividend payment|Income payment)\b/i;
const taxDocumentPattern = /\b(Steuerbelastung|Steuerabrechnung|Steuergutschrift|Steuererstattung|Tax refund|Tax charge|Vorabpauschale|Bruttothesaurierung)\b/i;
const feeDocumentPattern = /\b(Depotgeb.hr|Depotentgelt|Geb.hrenbelastung|Geb.hrengutschrift|Geb.hrenerstattung|Serviceentgelt|Service fee|Fee refund)\b/i;
const deliveryInPattern = /\b(Depoteinlieferung|Depot.?bertrag\s+(?:Eingang|eingehend)|Einlieferung|Einbuchung|Delivery In|Transfer In|Stockdividende|St.ckdividende|Gratisaktien)\b/i;
const deliveryOutPattern = /\b(Depotauslieferung|Depot.?bertrag\s+(?:Ausgang|ausgehend)|Auslieferung|Ausbuchung|Delivery Out|Transfer Out)\b/i;
const unitLabel = "(?:St(?:\\.|ück|ueck|.?ck)?|Stk\\.?|Anzahl|Nominale|Quantity|Quantit.|Cantidad|Quantità|Shares|Units)";
const unitSuffix = "(?:St\\.|Stk\\.?|St.ck|Anteile|Shares|Units|Pcs?\\.?|pc\\.?|Pz\\.?|unit.|titre\\(s\\)|t.t\\.?)";
const unitNumber = "[0-9][0-9.']*(?:[,.][0-9]+)?";
const unitsPatterns = [
  new RegExp(`\\b(${unitNumber})\\s*${unitSuffix}(?=\\s|$)`, "i"),
  new RegExp(`\\b(?:Ausgef.hrte St.ckzahl|Executed quantity|Ausgef.hrt|davon ausgef\\.|${unitLabel})\\s*[:\\-]?\\s*(?:${unitLabel}\\s*)?(${unitNumber})\\s*(?:${unitSuffix})?(?=\\s|$)`, "i"),
];
const currencies = "EUR|USD|CHF|GBP|CAD|AUD|JPY|SEK|NOK|DKK|PLN|CZK|HUF";
const netAmountLabels = [
  /Endbetrag/i,
  /Abrechnungsbetrag/i,
  /Gesamtbetrag/i,
  /Auszahlungsbetrag/i,
  /Gutschrift/i,
  /Belastung/i,
  /Debit/i,
  /Credit/i,
  /Addebito/i,
  /Zu Ihren Lasten/i,
  /Zu Ihren Gunsten/i,
  /Net(?:to)? amount/i,
  /Total/i,
  /Totale/i,
  /Amount/i,
];
const grossAmountLabels = [/Bruttoaussch.ttung/i, /Bruttothesaurierung/i, /Bruttobetrag/i, /Gross amount/i, /Kurswert/i];
const taxLabels = [/Einbeh\.\s*(?:Steuer|KESt|SichSt)/i, /Kapitalertragsteuer/i, /Kapitalertragsteuer \(KESt\)/i, /Quellensteuer/i, /Withholding tax/i];
const feeLabels = [/Provision/i, /Eigene Spesen/i, /Fremde Spesen/i, /Transaktionsentgelt/i, /Orderentgelt/i, /Serviceentgelt/i, /Depotgeb.hr/i, /\bGeb.hr\b/i, /\bFee\b/i];

const brokerDefinitions: BrokerDefinition[] = [
  { broker: "Flatex", identifiers: [/\bbiw AG\b/i, /\bFinTech Group Bank AG\b/i, /\bflatex Bank AG\b/i, /\bflatexDEGIRO Bank (?:AG|SE)\b/i, /\bflatex\b/i] },
  { broker: "Trade Republic", identifiers: [/\bTrade Republic\b/i] },
  { broker: "Scalable Capital", identifiers: [/\bScalable Capital\b/i] },
  { broker: "Baader Bank", identifiers: [/\bBaader Bank\b/i] },
  { broker: "DEGIRO", identifiers: [/\bDEGIRO\b/i] },
  { broker: "Interactive Brokers", identifiers: [/\bInteractive Brokers\b/i, /\bIBKR\b/i] },
  { broker: "DADAT", identifiers: [/\bDADAT\b/i] },
  { broker: "easybank", identifiers: [/\beasybank\b/i] },
  { broker: "DKB", identifiers: [/\bDeutsche Kreditbank\b/i, /\bDKB\b/i] },
  { broker: "ING", identifiers: [/\bING-DiBa\b/i, /\bING Deutschland\b/i, /\bING\b/i] },
  { broker: "comdirect", identifiers: [/\bcomdirect\b/i] },
  { broker: "Consorsbank", identifiers: [/\bConsorsbank\b/i] },
  { broker: "onvista", identifiers: [/\bonvista bank\b/i] },
  { broker: "Raiffeisen", identifiers: [/\bRaiffeisen\b/i] },
  { broker: "Erste Bank / Sparkasse", identifiers: [/\bErste Bank\b/i, /\bSparkasse\b/i] },
  { broker: "BAWAG", identifiers: [/\bBAWAG\b/i] },
];

export const brokerTransactionTypeLabels: Record<BrokerTransactionType, string> = {
  buy: "Kauf",
  sell: "Verkauf",
  dividend: "Dividende",
  tax: "Steuer",
  tax_refund: "Steuererstattung",
  fee: "Gebühr",
  fee_refund: "Gebührenerstattung",
  delivery_in: "Einlieferung",
  delivery_out: "Auslieferung",
};

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
    normalized = comma > dot ? compact.replaceAll(".", "").replace(",", ".") : compact.replaceAll(",", "");
  } else if (comma >= 0) {
    const parts = compact.split(",");
    normalized = parts.length > 2 && parts.slice(1).every((part) => part.length === 3) ? compact.replaceAll(",", "") : compact.replace(",", ".");
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
  if (/Transaktions.bersicht|Transaction Overview|Transactions|Transacties|Transacciones|Transazioni|Transakcje/i.test(normalized) && /\bDEGIRO\b/i.test(normalized)) {
    return brokerDefinitions.find((definition) => definition.broker === "DEGIRO") ?? null;
  }
  return brokerDefinitions.find((definition) => definition.identifiers.some((pattern) => pattern.test(normalized))) ?? null;
}

function buySellType(value: string): "buy" | "sell" | null {
  if (/Verkauf|Sell|Sale|Vente|Vendita|Venta|Verkoop/i.test(value)) return "sell";
  if (/Kauf|Buy|Purchase|Achat|Acquisto|Compra|Kopen|Sparplanausf.hrung|Round\s*up|investissement programm.|piano di accumulo|Saveback/i.test(value)) return "buy";
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

function pickDateByLabels(lines: string[], labels: string[]): string | null {
  const dateValue = `(20\\d{2}-[01]\\d-[0-3]\\d|[0-3]?\\d[.\\/-][01]?\\d[.\\/-](?:20)?\\d{2})`;
  for (const label of labels) {
    const pattern = new RegExp(`${label}[^\\d]*${dateValue}`, "i");
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return normalizeDate(match[1]);
    }
  }
  return null;
}

function pickDate(lines: string[], typeIndex = 0): string | null {
  const labelled = pickDateByLabels(lines, ["Handelstag", "Schlusstag", "Ausf.hrungstag", "Ausf.hrung", "Execution", "Trade date", "Execution date", "Zuflusstag", "Valuta", "Buchungstag", "Gesch.ftsdatum", "Orderdatum", "Datum", "Date", "Extag"]);
  if (labelled) return labelled;
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

function parseMoneyAfterLabel(line: string, label: RegExp): MoneyValue | null {
  const index = line.search(label);
  if (index < 0) return null;
  const labelled = line.slice(index).replace(label, "").replace(/^\s*:?\s*/, "");
  const currencyFirst = labelled.match(new RegExp(`^(${currencies})\\s*([+\\-]?\\s*[0-9][0-9.'\\s]*(?:[,.][0-9]+)?)`, "i"));
  const amountFirst = labelled.match(new RegExp(`^([+\\-]?\\s*[0-9][0-9.'\\s]*(?:[,.][0-9]+)?)\\s*(${currencies})\\b`, "i"));
  const match = currencyFirst ?? amountFirst;
  if (!match) return null;
  const currency = (currencyFirst ? match[1] : match[2]).toUpperCase();
  const rawText = (currencyFirst ? match[2] : match[1]).replace(/\s/g, "");
  const raw = parseLocaleNumber(rawText);
  if (raw === null) return null;
  return { amount: Math.abs(raw), currency, raw };
}

function pickMoney(lines: string[], labels: RegExp[]): MoneyValue | null {
  for (const label of labels) {
    for (const line of lines) {
      const money = parseMoneyAfterLabel(line, label);
      if (money) return money;
    }
  }
  return null;
}

function sumMoney(lines: string[], labels: RegExp[], preferredCurrency: string | null = null): number | null {
  const values: MoneyValue[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    for (let index = 0; index < lines.length; index += 1) {
      const money = parseMoneyAfterLabel(lines[index], label);
      if (!money) continue;
      const key = `${index}|${label.source}|${money.currency}|${money.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(money);
    }
  }
  const compatible = preferredCurrency ? values.filter((value) => value.currency === preferredCurrency) : values;
  const selected = compatible.length > 0 ? compatible : values;
  if (selected.length === 0) return null;
  return Math.round((selected.reduce((sum, value) => sum + value.amount, 0) + Number.EPSILON) * 1e8) / 1e8;
}

function pickExchangeRate(lines: string[]): number | null {
  for (const line of lines) {
    const match = line.match(/(?:Devisenkurs|Exchange rate)\s*:?\s*([0-9][0-9.,]*)/i);
    const value = match ? parseLocaleNumber(match[1]) : null;
    if (value !== null && value > 0) return value;
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
    .replace(/^Nominale\s+/i, "")
    .trim();
  if (sameLine.length >= 4 && !/^(WKN|St.ck|Anzahl)/i.test(sameLine)) return sameLine.slice(0, 160);
  const previous = lines[isinIndex - 1]?.trim();
  if (previous && previous.length >= 4 && !buySellPattern.test(previous)) return previous.slice(0, 160);
  const next = lines[isinIndex + 1]?.trim();
  if (next && next.length >= 4 && !/^STK\s+[0-9]/i.test(next)) return next.slice(0, 160);
  return null;
}

function pickFlatexSecurity(lines: string[]): { isin: string; name: string | null; index: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^Nr\.\s*\d+(?:\/\d+)?\s+(.+?)\s+\(([A-Z]{2}[A-Z0-9]{9}[0-9])(?:\/[A-Z0-9]{6})?\)\s*$/i);
    if (match) return { isin: match[2], name: match[1].trim().slice(0, 160), index };
  }
  const isinIndex = lines.findIndex((line) => isinPattern.test(line));
  if (isinIndex < 0) return null;
  const isin = lines[isinIndex].match(isinPattern)![0];
  return { isin, name: pickSecurityName(lines, isinIndex, isin), index: isinIndex };
}

type DraftValues = {
  type: BrokerTransactionType;
  isin?: string | null;
  securityName?: string | null;
  date: string;
  units?: number | null;
  amount?: MoneyValue | null;
  gross?: MoneyValue | null;
  taxAmount?: number | null;
  feeAmount?: number | null;
  exchangeRate?: number | null;
  confidence?: ImportConfidence;
};

function buildDraft(sourceFile: string, broker: string | null, lines: string[], values: DraftValues): BrokerTransactionDraft {
  const net = values.amount === undefined ? pickMoney(lines, netAmountLabels) : values.amount;
  const gross = values.gross === undefined ? pickMoney(lines, grossAmountLabels) : values.gross;
  const currency = net?.currency ?? gross?.currency ?? null;
  const taxAmount = values.taxAmount === undefined ? pickMoney(lines, taxLabels)?.amount ?? null : values.taxAmount;
  const feeAmount = values.feeAmount === undefined ? sumMoney(lines, feeLabels, currency) : values.feeAmount;
  const exchangeRate = values.exchangeRate === undefined ? pickExchangeRate(lines) : values.exchangeRate;
  const completeByType = values.type === "delivery_in" || values.type === "delivery_out"
    ? Boolean(values.isin && values.units !== null && values.units !== undefined)
    : Boolean(net);
  const confidence = values.confidence ?? (broker ? completeByType ? "high" : "medium" : "low");
  return {
    sourceFile,
    broker,
    type: values.type,
    isin: values.isin ?? null,
    securityName: values.securityName ?? null,
    date: values.date,
    units: values.units ?? null,
    amount: net?.amount ?? null,
    currency,
    grossAmount: gross?.amount ?? null,
    grossCurrency: gross?.currency ?? null,
    taxAmount: taxAmount ?? null,
    feeAmount: feeAmount ?? null,
    exchangeRate: exchangeRate ?? null,
    confidence,
    evidence: lines.join(" | ").slice(0, 900),
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

    const type = buySellType(blockText);
    const order = firstMatch(block, [
      /^Nr\.\s*\d+(?:\/\d+)?\s+(?:Kauf|Verkauf)\s+(.+?)\s+\(([A-Z]{2}[A-Z0-9]{9}[0-9])(?:\/[A-Z0-9]{6})?\)\s*$/i,
      /^(?:Kauf|Verkauf)\s+(.+?)\s+\(([A-Z]{2}[A-Z0-9]{9}[0-9])(?:\/[A-Z0-9]{6})?\)\s*$/i,
    ]);
    const isinIndex = block.findIndex((line) => isinPattern.test(line));
    const isin = order?.[2] ?? (isinIndex >= 0 ? block[isinIndex].match(isinPattern)?.[0] ?? null : null);
    const units = pickUnits(block, 0);
    const date = pickDateByLabels(block, ["Handelstag", "Schlusstag", "Ausf.hrungstag"]) ?? pickDate(block, 0);
    if (!type || !isin || units === null || !date) continue;
    const securityName = order?.[1]?.trim().slice(0, 160) ?? pickSecurityName(block, isinIndex, isin);
    transactions.push(buildDraft(sourceFile, "Flatex", block, { type, isin, securityName, units, date }));
  }

  return transactions;
}

function parseFlatexIncome(lines: string[], sourceFile: string): BrokerTransactionDraft[] {
  const text = lines.join("\n");
  if (!/\bErtragsmitteilung\b/i.test(text)) return [];
  const security = pickFlatexSecurity(lines);
  if (!security) return [];
  const units = pickUnits(lines, security.index);
  const date = pickDateByLabels(lines, ["Zuflusstag", "Valuta", "Extag"]) ?? pickDate(lines, security.index);
  if (!date) return [];

  const net = pickMoney(lines, netAmountLabels);
  const gross = pickMoney(lines, grossAmountLabels);
  const taxMoney = pickMoney(lines, taxLabels);
  const feeAmount = sumMoney(lines, feeLabels, net?.currency ?? null);
  const exchangeRate = pickExchangeRate(lines);

  if (/\bBruttoaussch.ttung\b/i.test(text) || /\baussch.ttender(?:\/teilthesaurierender)? Fonds\b/i.test(text)) {
    return [buildDraft(sourceFile, "Flatex", lines, {
      type: "dividend",
      isin: security.isin,
      securityName: security.name,
      date,
      units,
      amount: net,
      gross,
      taxAmount: taxMoney?.amount ?? null,
      feeAmount,
      exchangeRate,
    })];
  }

  if (/\bBruttothesaurierung\b/i.test(text) || /\bthesaurierender .*Fonds\b/i.test(text)) {
    const taxNet = taxMoney ?? net;
    return [buildDraft(sourceFile, "Flatex", lines, {
      type: taxMoney?.raw && taxMoney.raw < 0 ? "tax_refund" : "tax",
      isin: security.isin,
      securityName: security.name,
      date,
      units,
      amount: taxNet,
      gross,
      taxAmount: taxMoney?.amount ?? net?.amount ?? null,
      feeAmount,
      exchangeRate,
    })];
  }

  return [];
}

/**
 * DEGIRO transaction overviews are tables rather than one document per trade.
 * Portfolio Performance likewise treats every row as its own transaction and
 * derives buy/sell from the sign of the quantity. Keep this deliberately
 * separate from the generic prose parser so page headers and cash-account rows
 * cannot be mistaken for securities trades.
 */
function parseDegiroTransactionOverview(lines: string[], sourceFile: string): BrokerTransactionDraft[] {
  if (!lines.some((line) => /Transaktions.bersicht|Transactions|Transacties|Transacciones|Transazioni|Transakcje|Transa..es/i.test(line))) return [];
  const transactions: BrokerTransactionDraft[] = [];

  for (const line of lines) {
    const prefix = line.match(/^(\d{2}[-./]\d{2}[-./]\d{4})\s+\d{2}:\d{2}\s+(.+?)\s+([A-Z]{2}[A-Z0-9]{9}[0-9])\s+(.+)$/);
    if (!prefix) continue;
    const date = normalizeDate(prefix[1]);
    if (!date) continue;

    const tail = prefix[4].trim();
    const firstCurrency = tail.search(new RegExp(`\\b(?:${currencies})\\b`, "i"));
    if (firstCurrency < 0) continue;
    const beforeCurrency = tail.slice(0, firstCurrency).trim().split(/\s+/);
    const numericBeforeCurrency = beforeCurrency.filter((token) => /^[+\-]?[0-9][0-9.,']*$/.test(token));
    if (numericBeforeCurrency.length === 0) continue;

    // Normal shares: "XET XETA 6 62.06 EUR". Some derivatives use
    // "ERX -3 EUR 30,00 EUR", where quantity is directly before currency.
    const quantityToken = numericBeforeCurrency.length >= 2
      ? numericBeforeCurrency[numericBeforeCurrency.length - 2]
      : numericBeforeCurrency[0];
    const signedUnits = parseLocaleNumber(quantityToken);
    if (signedUnits === null || signedUnits === 0) continue;

    const moneyMatches = [...line.matchAll(new RegExp(`([+\\-]?[0-9][0-9.'\\s]*(?:[,.][0-9]+)?)\\s+(${currencies})\\b`, "gi"))];
    const lastMoney = moneyMatches.at(-1);
    const amountValue = lastMoney ? parseLocaleNumber(lastMoney[1]) : null;
    const amount = lastMoney && amountValue !== null
      ? { amount: Math.abs(amountValue), currency: lastMoney[2].toUpperCase(), raw: amountValue }
      : null;
    const units = Math.abs(signedUnits);
    transactions.push(buildDraft(sourceFile, "DEGIRO", [line], {
      type: signedUnits < 0 ? "sell" : "buy",
      isin: prefix[3],
      securityName: prefix[2].trim().slice(0, 160),
      date,
      units,
      amount,
      confidence: "high",
    }));
  }

  return transactions;
}

function parseTradeRepublicSecurities(lines: string[], sourceFile: string): BrokerTransactionDraft[] {
  const text = lines.join("\n");
  if (!/Trade Republic/i.test(text) || !/(WERTPAPIERABRECHNUNG|SECURITIES SETTLEMENT|REGOLAMENTO TITOLI|LIQUIDACI.N DE VALORES|CONFIRMATION DE L.INVESTISSEMENT)/i.test(text)) return [];
  if (/\b(?:Crypto|Krypto|Bitcoin|Ethereum)\b/i.test(text)) return [];

  const isinIndexes = lines.flatMap((line, index) => isinPattern.test(line) ? [index] : []);
  const transactions: BrokerTransactionDraft[] = [];
  for (const isinIndex of isinIndexes) {
    const isin = lines[isinIndex].match(isinPattern)?.[0];
    if (!isin) continue;
    const before = lines.slice(Math.max(0, isinIndex - 24), isinIndex);
    const actionIndex = before.findLastIndex((line) => buySellPattern.test(line) || /(?:Ausf.hrung|execution|Ex.cution|Esecuzione).*(?:am|on|le|il|el d.a)/i.test(line));
    const actionLine = actionIndex >= 0 ? before[actionIndex] : "";
    let type = buySellType(actionLine);
    if (!type && /(SPARPLAN|SAVINGS PLAN|SAVEBACK|ROUND UP|KINDERGELD|INVESTISSEMENT PROGRAMM.|PLAN D..PARGNE|PIANO DI ACCUMULO)/i.test(text)) type = "buy";
    const date = normalizeDate(actionLine) ?? pickDate(before, Math.max(0, actionIndex));
    if (!type || !date) continue;

    const positionCandidates = before.slice(Math.max(0, before.length - 8)).reverse();
    let position: { name: string; units: number } | null = null;
    for (const line of positionCandidates) {
      const unitMatch = unitsPatterns.map((pattern) => line.match(pattern)).find(Boolean);
      const threeNumbers = line.match(new RegExp(`^(.+?)\\s+(${unitNumber})(?:\\s+${unitSuffix})?\\s+${unitNumber}\\s+(?:${currencies}|%)\\s+${unitNumber}\\s+(?:${currencies})$`, "i"));
      const rawUnits = unitMatch?.[1] ?? threeNumbers?.[2] ?? null;
      const units = rawUnits ? parseLocaleNumber(rawUnits) : null;
      if (units !== null && units > 0) {
        const name = threeNumbers?.[1] ?? line.slice(0, unitMatch?.index ?? 0).trim();
        position = { name: name.trim().slice(0, 160), units };
        break;
      }
    }
    if (!position) continue;

    const block = lines.slice(Math.max(0, isinIndex - 24), Math.min(lines.length, isinIndex + 14));
    transactions.push(buildDraft(sourceFile, "Trade Republic", block, {
      type,
      isin,
      securityName: position.name || pickSecurityName(lines, isinIndex, isin),
      units: position.units,
      date,
    }));
  }
  return transactions;
}

function parseGenericBuySell(lines: string[], sourceFile: string, broker: string | null): BrokerTransactionDraft[] {
  const typeIndexes = lines.flatMap((line, index) => buySellPattern.test(line) ? [index] : []);
  const candidates: BrokerTransactionDraft[] = [];

  for (const typeIndex of typeIndexes) {
    const start = Math.max(0, typeIndex - 12);
    const end = Math.min(lines.length, typeIndex + 48);
    const block = lines.slice(start, end);
    const localTypeIndex = typeIndex - start;
    const type = buySellType(lines[typeIndex]);
    const nearestIsins = block.flatMap((line, index) => isinPattern.test(line) ? [{ index, distance: Math.abs(index - localTypeIndex), isin: line.match(isinPattern)![0] }] : []);
    nearestIsins.sort((a, b) => a.distance - b.distance);
    const isinMatch = nearestIsins[0];
    const units = pickUnits(block, localTypeIndex);
    const date = pickDate(block, localTypeIndex);
    if (!type || !isinMatch || units === null || !date) continue;
    const securityName = pickSecurityName(block, isinMatch.index, isinMatch.isin);
    candidates.push(buildDraft(sourceFile, broker, block, { type, isin: isinMatch.isin, securityName, units, date }));
  }

  return candidates;
}

function parseGenericDividend(lines: string[], sourceFile: string, broker: string | null): BrokerTransactionDraft[] {
  const text = lines.join("\n");
  if (!dividendDocumentPattern.test(text) || /\bWertpapierabrechnung\s+(?:Kauf|Verkauf)\b/i.test(text)) return [];
  if (/\bBruttothesaurierung\b/i.test(text)) return [];
  const isinIndex = lines.findIndex((line) => isinPattern.test(line));
  if (isinIndex < 0) return [];
  const isin = lines[isinIndex].match(isinPattern)![0];
  const date = pickDateByLabels(lines, ["Zahlungstag", "Zuflusstag", "Valuta", "Ex-?Tag", "Extag", "Datum"]) ?? pickDate(lines, isinIndex);
  const amount = pickMoney(lines, netAmountLabels);
  if (!date || !amount) return [];
  const units = pickUnits(lines, isinIndex);
  return [buildDraft(sourceFile, broker, lines, {
    type: "dividend",
    isin,
    securityName: pickSecurityName(lines, isinIndex, isin),
    date,
    units,
    amount,
  })];
}

function parseStandaloneTax(lines: string[], sourceFile: string, broker: string | null): BrokerTransactionDraft[] {
  const text = lines.join("\n");
  if (!taxDocumentPattern.test(text)) return [];
  if (/\bErtragsmitteilung\b/i.test(text) && broker === "Flatex") return [];
  const isinIndex = lines.findIndex((line) => isinPattern.test(line));
  const isin = isinIndex >= 0 ? lines[isinIndex].match(isinPattern)?.[0] ?? null : null;
  const date = pickDateByLabels(lines, ["Zuflusstag", "Valuta", "Buchungstag", "Datum", "Extag"]) ?? pickDate(lines, Math.max(0, isinIndex));
  const taxMoney = pickMoney(lines, taxLabels);
  const amount = taxMoney ?? pickMoney(lines, netAmountLabels);
  if (!date || !amount) return [];
  const refund = /\b(Steuergutschrift|Steuererstattung|Tax refund)\b/i.test(text) || amount.raw < 0;
  return [buildDraft(sourceFile, broker, lines, {
    type: refund ? "tax_refund" : "tax",
    isin,
    securityName: isin && isinIndex >= 0 ? pickSecurityName(lines, isinIndex, isin) : null,
    date,
    units: isin ? pickUnits(lines, isinIndex) : null,
    amount,
    taxAmount: amount.amount,
  })];
}

function parseFeeDocument(lines: string[], sourceFile: string, broker: string | null): BrokerTransactionDraft[] {
  const text = lines.join("\n");
  if (!feeDocumentPattern.test(text)) return [];
  if (buySellPattern.test(text)) return [];
  const isinIndex = lines.findIndex((line) => isinPattern.test(line));
  const isin = isinIndex >= 0 ? lines[isinIndex].match(isinPattern)?.[0] ?? null : null;
  const date = pickDateByLabels(lines, ["Valuta", "Buchungstag", "Datum"]) ?? pickDate(lines, Math.max(0, isinIndex));
  const feeMoney = pickMoney(lines, [...netAmountLabels, ...feeLabels]);
  if (!date || !feeMoney) return [];
  const refund = /\b(Geb.hrengutschrift|Geb.hrenerstattung|Fee refund)\b/i.test(text) || feeMoney.raw < 0;
  return [buildDraft(sourceFile, broker, lines, {
    type: refund ? "fee_refund" : "fee",
    isin,
    securityName: isin && isinIndex >= 0 ? pickSecurityName(lines, isinIndex, isin) : null,
    date,
    units: null,
    amount: feeMoney,
    feeAmount: feeMoney.amount,
    taxAmount: null,
  })];
}

function deliveryType(text: string): "delivery_in" | "delivery_out" | null {
  if (deliveryOutPattern.test(text)) return "delivery_out";
  if (deliveryInPattern.test(text)) return "delivery_in";
  return null;
}

function parseDeliveries(lines: string[], sourceFile: string, broker: string | null): BrokerTransactionDraft[] {
  const text = lines.join("\n");
  const type = deliveryType(text);
  if (!type) return [];
  const isinIndexes = lines.flatMap((line, index) => isinPattern.test(line) ? [index] : []);
  const transactions: BrokerTransactionDraft[] = [];

  for (let position = 0; position < isinIndexes.length; position += 1) {
    const start = isinIndexes[position];
    const end = Math.min(lines.length, (isinIndexes[position + 1] ?? lines.length), start + 18);
    const block = lines.slice(start, end);
    const isin = block[0].match(isinPattern)?.[0] ?? null;
    if (!isin) continue;
    const units = pickUnits(block, 0);
    const date = pickDateByLabels(block, ["Handelstag", "Valuta", "Buchungstag", "Datum"]) ?? pickDate(block, 0) ?? pickDate(lines, start);
    if (units === null || !date) continue;
    let securityName = pickSecurityName(block, 0, isin);
    const stkLine = block.find((line) => /^STK\s+[0-9]/i.test(line));
    if (stkLine) {
      const name = stkLine.replace(/^STK\s+[0-9][0-9.'\s]*(?:[,.][0-9]+)?\s*/i, "").trim();
      if (name.length >= 3) securityName = name.slice(0, 160);
    }
    transactions.push(buildDraft(sourceFile, broker, block, { type, isin, securityName, date, units, amount: null, taxAmount: null, feeAmount: null, confidence: broker ? "high" : "medium" }));
  }

  return transactions;
}

function deduplicateTransactions(candidates: BrokerTransactionDraft[]): BrokerTransactionDraft[] {
  const unique = new Map<string, BrokerTransactionDraft>();
  for (const candidate of candidates) {
    const key = `${candidate.type}|${candidate.isin ?? ""}|${candidate.date}|${candidate.units ?? ""}|${candidate.amount ?? ""}|${candidate.currency ?? ""}`;
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
  const unsupportedFlatexSavingsSummary = broker === "Flatex" && /Sammelabrechnung\s+aus/i.test(text);
  const warnings: string[] = [];
  const candidates: BrokerTransactionDraft[] = [];

  if (broker === "Flatex" && !unsupportedFlatexSavingsSummary) {
    candidates.push(...parseFlatexBuySell(lines, sourceFile));
    candidates.push(...parseFlatexIncome(lines, sourceFile));
  }
  if (broker === "DEGIRO") candidates.push(...parseDegiroTransactionOverview(lines, sourceFile));
  if (broker === "Trade Republic") candidates.push(...parseTradeRepublicSecurities(lines, sourceFile));
  candidates.push(...parseDeliveries(lines, sourceFile, broker));
  if (!unsupportedFlatexSavingsSummary && !candidates.some((transaction) => transaction.type === "buy" || transaction.type === "sell")) candidates.push(...parseGenericBuySell(lines, sourceFile, broker));
  if (!candidates.some((transaction) => transaction.type === "dividend")) candidates.push(...parseGenericDividend(lines, sourceFile, broker));
  if (!candidates.some((transaction) => transaction.type === "tax" || transaction.type === "tax_refund")) candidates.push(...parseStandaloneTax(lines, sourceFile, broker));
  if (!candidates.some((transaction) => transaction.type === "fee" || transaction.type === "fee_refund")) candidates.push(...parseFeeDocument(lines, sourceFile, broker));

  const transactions = deduplicateTransactions(candidates);
  if (unsupportedFlatexSavingsSummary) warnings.push("Flatex-Sammelabrechnungen aus Zahlungsplänen werden bewusst nicht automatisch importiert. Bitte die einzelnen Kauf-/Verkaufsabrechnungen oder eine DEGIRO-Transaktionsübersicht verwenden.");
  if (transactions.length === 0) {
    warnings.push("Kein vollständig unterstützter Broker-Beleg erkannt. Importiert werden nur Dokumente, deren Typ und Pflichtfelder eindeutig zusammenpassen.");
    if (broker) warnings.push(`${broker} wurde erkannt, das konkrete Dokumentlayout ist aber noch nicht unterstützt.`);
  }
  if (!broker) warnings.push("Broker nicht eindeutig erkannt; die gefundenen Werte besonders sorgfältig prüfen.");
  if (transactions.some((transaction) => transaction.confidence !== "high")) warnings.push("Mindestens eine Transaktion wurde nur mit mittlerer oder niedriger Sicherheit erkannt und sollte kontrolliert werden.");
  return { broker, transactions, warnings };
}

export function holdingDeltaForTransaction(transaction: Pick<BrokerTransaction, "type" | "units">): number {
  const units = transaction.units ?? 0;
  if (transaction.type === "buy" || transaction.type === "delivery_in") return units;
  if (transaction.type === "sell" || transaction.type === "delivery_out") return -units;
  return 0;
}

export function unitsAtDate(transactions: BrokerTransaction[], isin: string, cutoffDate: string): { units: number; matchedTransactions: number } {
  const normalized = isin.trim().toUpperCase();
  const eligible = transactions.filter((transaction) => transaction.isin === normalized && transaction.date <= cutoffDate && holdingDeltaForTransaction(transaction) !== 0);
  const units = eligible.reduce((sum, transaction) => sum + holdingDeltaForTransaction(transaction), 0);
  return { units: Math.round((units + Number.EPSILON) * 1e8) / 1e8, matchedTransactions: eligible.length };
}

export function currentUnitsByIsin(transactions: BrokerTransaction[]): Array<{ isin: string; units: number; transactions: number }> {
  const grouped = new Map<string, BrokerTransaction[]>();
  for (const transaction of transactions) {
    if (!transaction.isin || holdingDeltaForTransaction(transaction) === 0) continue;
    grouped.set(transaction.isin, [...(grouped.get(transaction.isin) ?? []), transaction]);
  }
  return [...grouped.entries()].map(([isin, entries]) => ({
    isin,
    units: Math.round((entries.reduce((sum, entry) => sum + holdingDeltaForTransaction(entry), 0) + Number.EPSILON) * 1e8) / 1e8,
    transactions: entries.length,
  })).sort((a, b) => a.isin.localeCompare(b.isin));
}
