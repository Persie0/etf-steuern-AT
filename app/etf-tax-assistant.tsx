"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { calculateCorrectedCostBasis, calculateEtfTax, FundStatus } from "../lib/tax";
import type { CostBasisCorrection } from "../lib/tax";
import { parseEditableNumber } from "../lib/editable-number";
import { selectLatestHeldPositions } from "../lib/portfolio";
import { OekbExtraction, parseOekbTextLocally } from "../lib/oekb-extractor";
import type { OekbReportHistoryItem, OekbReportPrediction } from "../lib/oekb-csv";
import { brokerTransactionTypeLabels, currentUnitsByIsin, parseBrokerPdfText, unitsAtDate } from "../lib/broker-transactions";
import type { BrokerTransaction } from "../lib/broker-transactions";
import { extractPdfText } from "../lib/pdf-text";
import { createAppBackup, parseAppBackup } from "../lib/app-backup";
import { buildPortfolioWorkbook } from "../lib/xlsx-export";

type NumberField = "units" | "eurRate" | "distributionsPerUnit" | "deemedIncomePerUnit" | "creditableTaxPerUnit" | "costAdjustmentPerUnit" | "baseAcquisitionCost" | "saleProceeds" | "saleCostBasis" | "saleFees" | "saleFxRate" | "openingPricePerUnit" | "closingPricePerUnit";
type Values = Record<NumberField, number>;
type Security = { identifier: string; identifierType: "ISIN" | "WKN"; name: string | null; ticker: string | null; exchange: string | null; verified: boolean };
type AutomaticOekbResult = OekbExtraction & { reportId: string; source: string; sourceUrl: string; availableYears: string[]; reportHistory: OekbReportHistoryItem[]; prediction: OekbReportPrediction | null };
type PendingOekbInfo = { error: string; availableYears: string[]; reportHistory: OekbReportHistoryItem[]; prediction: OekbReportPrediction | null };
type ReportTracking = { state: "available" | "pending"; lastCheckedAt: string; message: string | null; reportHistory: OekbReportHistoryItem[]; prediction: OekbReportPrediction | null };
type OwnershipStatus = "held" | "sold";
type SaleCurrency = "EUR" | "USD";
type PortfolioEntry = {
  id: string;
  identifier: string;
  taxYear: string;
  status: FundStatus;
  ownershipStatus: OwnershipStatus;
  values: Values;
  security: Security | null;
  oekbResult: AutomaticOekbResult | null;
  importResult: OekbExtraction | null;
  showSale: boolean;
  saleCurrency?: SaleCurrency;
  saleDate?: string;
  result: ReturnType<typeof calculateEtfTax>;
  reportTracking?: ReportTracking;
  savedAt: string;
};

const initialValues: Values = { units: 0, eurRate: 1, distributionsPerUnit: 0, deemedIncomePerUnit: 0, creditableTaxPerUnit: 0, costAdjustmentPerUnit: 0, baseAcquisitionCost: 0, saleProceeds: 0, saleCostBasis: 0, saleFees: 0, saleFxRate: 1, openingPricePerUnit: 0, closingPricePerUnit: 0 };
const currentTaxYear = String(new Date().getUTCFullYear());
const eur = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" });
const reportDateFormatter = new Intl.DateTimeFormat("de-AT", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
const shortDateFormatter = new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const geminiModels = ["gemini-3-flash-preview", "gemini-3.7-flash", "gemini-2.5-flash-lite"];

function formatReportDate(date: string | null | undefined) {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : reportDateFormatter.format(parsed);
}

function formatShortDate(date: string | null | undefined) {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : shortDateFormatter.format(parsed);
}

function formatBrokerTransactionValue(item: BrokerTransaction) {
  if ((item.type === "buy" || item.type === "sell" || item.type === "delivery_in" || item.type === "delivery_out") && item.units !== null) {
    return `${item.units.toLocaleString("de-AT", { maximumFractionDigits: 8 })} Stk.`;
  }
  if (item.amount !== null) return `${item.amount.toLocaleString("de-AT", { maximumFractionDigits: 2 })}${item.currency ? ` ${item.currency}` : ""}`;
  if (item.units !== null) return `${item.units.toLocaleString("de-AT", { maximumFractionDigits: 8 })} Stk.`;
  return "—";
}

const confidenceLabel = { high: "hohes Vertrauen", medium: "mittleres Vertrauen", low: "grobe Schätzung" } as const;

function valuesWithExtraction(current: Values, extracted: OekbExtraction): Values {
  return {
    ...current,
    eurRate: extracted.eurRate ?? current.eurRate,
    distributionsPerUnit: extracted.actualDistributionPerUnit ?? current.distributionsPerUnit,
    deemedIncomePerUnit: extracted.deemedIncomePerUnit ?? current.deemedIncomePerUnit,
    creditableTaxPerUnit: extracted.creditableForeignTaxPerUnit ?? current.creditableTaxPerUnit,
    costAdjustmentPerUnit: extracted.costBasisAdjustmentPerUnit ?? current.costAdjustmentPerUnit,
  };
}

function calculateSnapshot(status: FundStatus, values: Values, showSale: boolean, saleCurrency: SaleCurrency = "EUR") {
  return calculateEtfTax({
    status,
    ...values,
    saleProceeds: showSale ? values.saleProceeds : 0,
    saleCostBasis: showSale ? values.saleCostBasis : 0,
    saleFees: showSale ? values.saleFees : 0,
    saleFxRate: showSale && saleCurrency === "USD" ? values.saleFxRate : 1,
  });
}

const extractionSchema = {
  type: "object",
  properties: {
    isin: { type: "string", nullable: true }, fundName: { type: "string", nullable: true },
    currency: { type: "string", nullable: true }, reportDate: { type: "string", nullable: true, description: "YYYY-MM-DD" },
    eurRate: { type: "number", nullable: true, description: "Explicitly displayed EUR per one unit foreign currency; never calculate or guess." },
    actualDistributionPerUnit: { type: "number", nullable: true }, deemedIncomePerUnit: { type: "number", nullable: true },
    creditableForeignTaxPerUnit: { type: "number", nullable: true }, costBasisAdjustmentPerUnit: { type: "number", nullable: true },
    evidence: { type: "object", properties: {
      eurRate: { type: "string", nullable: true }, actualDistributionPerUnit: { type: "string", nullable: true },
      deemedIncomePerUnit: { type: "string", nullable: true }, creditableForeignTaxPerUnit: { type: "string", nullable: true },
      costBasisAdjustmentPerUnit: { type: "string", nullable: true },
    }, required: ["eurRate", "actualDistributionPerUnit", "deemedIncomePerUnit", "creditableForeignTaxPerUnit", "costBasisAdjustmentPerUnit"] },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["isin", "fundName", "currency", "reportDate", "eurRate", "actualDistributionPerUnit", "deemedIncomePerUnit", "creditableForeignTaxPerUnit", "costBasisAdjustmentPerUnit", "evidence", "warnings"],
};

async function extractWithGemini(apiKey: string, pastedText: string): Promise<OekbExtraction> {
  const prompt = `Du extrahierst ausschließlich Werte aus einer kopierten OeKB-Fondssteuerdaten-Seite für Österreich.\n
Regeln:\n- Verwende die Jahresmeldung bzw. die vom Nutzer kopierte Detailansicht.\n- Gib Beträge JE ANTEIL zurück, nicht Gesamtbeträge.\n- Bewahre Vorzeichen, insbesondere bei der Anschaffungskostenkorrektur.\n- Österreichische Dezimalkommas sind Dezimalzeichen.\n- eurRate ist nur ein ausdrücklich angezeigter Kurs in EUR je Einheit Fremdwährung (EUR/FW). Nicht berechnen und nicht raten. Bei EUR ist 1 zulässig.\n- Fehlende oder mehrdeutige Werte sind null, niemals 0. Ein ausdrücklich angezeigter Nullwert bleibt 0.\n- evidence enthält für jedes Zahlenfeld eine kurze wörtliche Fundstelle aus dem Text.\n- Weise in warnings auf mehrere Meldungen, unklare Spalten, andere Anteilsklassen oder fehlende Werte hin.\n\nKOPIERTE OeKB-SEITE:\n${pastedText.slice(0, 150000)}`;
  let lastError = "Gemini-Aufruf fehlgeschlagen.";
  for (const model of geminiModels) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: extractionSchema } }),
    });
    if (!response.ok) {
      const details = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      lastError = details?.error?.message ?? `Gemini HTTP ${response.status}`;
      if ([400, 404, 429].includes(response.status)) continue;
      throw new Error(lastError);
    }
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const output = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!output) throw new Error("Gemini hat keine auswertbare Antwort geliefert.");
    const parsed = JSON.parse(output) as OekbExtraction;
    return { ...parsed, model };
  }
  throw new Error(lastError);
}

function Info({ children }: { children: React.ReactNode }) {
  return <span className="info" tabIndex={0} aria-label={`Erklärung: ${String(children)}`}>i<span className="info-popover" role="tooltip">{children}</span></span>;
}

function Field({ label, value, onChange, suffix = "EUR", hint, step = "0.0001", allowNegative = false, imported = false, importLabel = "OeKB importiert", className = "" }: { label: string; value: number; onChange: (value: number) => void; suffix?: string; hint?: string; step?: string; allowNegative?: boolean; imported?: boolean; importLabel?: string; className?: string }) {
  const [emptyDraft, setEmptyDraft] = useState(false);
  const displayedValue: number | string = emptyDraft && value === 0 ? "" : value;
  return <label className={`field ${imported ? "field-imported" : ""} ${className}`.trim()}>
    <span className="field-label-row"><span>{label} {hint && <Info>{hint}</Info>}</span>{imported && <em className="imported-pill">✓ {importLabel}</em>}</span>
    <div className="input-shell"><input inputMode="decimal" min={allowNegative ? undefined : "0"} step={step} type="number" value={displayedValue} onFocus={(event) => { if (displayedValue === 0) event.currentTarget.select(); }} onChange={(event) => { setEmptyDraft(event.target.value === ""); onChange(parseEditableNumber(event.target.value)); }} /><em>{suffix}</em></div>
  </label>;
}

function Tutorial({ onClose }: { onClose: () => void }) {
  return <section className="tutorial-page" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
    <header className="tutorial-topbar"><div className="brand"><span className="brand-mark">AT</span><span><strong>ETF-Steuer</strong><small>Praxis-Tutorial</small></span></div><button type="button" onClick={onClose}>Überspringen ×</button></header>
    <div className="tutorial-shell">
      <section className="tutorial-hero"><div><p className="eyebrow">Beim ersten Start · etwa 6 Minuten</p><h1 id="tutorial-title">Verstehen, rechnen, richtig eintragen.</h1><p>Das Tutorial zeigt mit einem echten ETF und echten historischen OeKB-Meldungen, was jedes Jahr besteuert wird, wie die Beträge entstehen und warum sie bei einem Auslandsbroker in die E1kv-Beilage gehören.</p><button type="button" onClick={() => document.querySelector("#tutorial-flow")?.scrollIntoView({ behavior: "smooth" })}>Tutorial starten <span>↓</span></button></div><aside><b>Für wen ist das?</b><p>Für österreichische Privatanleger, deren Broker <strong>keine österreichische KESt automatisch abführt</strong>.</p><p>Bei einem steuereinfachen österreichischen Depot erledigt die Bank diese Schritte normalerweise.</p></aside></section>

      <section className="tutorial-flow" id="tutorial-flow" aria-label="ETF im Tool hinzufügen"><div className="tutorial-section-heading"><span>01</span><div><p className="eyebrow">Erste Position</p><h2>So fügst du einen ETF hinzu</h2></div></div><div className="tutorial-steps"><article><span>1</span><h3>ISIN eingeben</h3><p>Im Praxisfall <code>IE00BK5BQT80</code>. Wähle das Steuerjahr und tippe auf „ETF & OeKB laden“.</p></article><article><span>2</span><h3>Meldetag prüfen</h3><p>Das Tool zeigt die offizielle Jahresmeldung und den steuerlichen Stichtag deutlich an.</p></article><article><span>3</span><h3>Stückzahl eintragen</h3><p>Nimm aus deinem Depotauszug den Bestand an genau diesem Meldetag — nicht den heutigen Bestand.</p></article><article><span>4</span><h3>Speichern</h3><p>Steuer, E1kv-Kennzahlen und AK-Korrektur werden berechnet und im lokalen Portfolio abgelegt.</p></article></div></section>

      <section className="tutorial-calculation"><div className="tutorial-section-heading"><span>02</span><div><p className="eyebrow">Was berechnet das Tool?</p><h2>Vier Rechenschritte, zwei unterschiedliche Zwecke</h2></div></div><div className="calculation-grid"><article><span>A</span><h3>OeKB-Werte in Euro</h3><p><b>Wert je Anteil × Stückzahl am Meldetag × EUR/FW-Kurs</b></p><small>So werden Ausschüttung, ausschüttungsgleiche Erträge, Quellensteuer und AK-Korrektur aus der Fondswährung in deinen Euro-Gesamtbetrag umgerechnet.</small></article><article><span>B</span><h3>Laufende Steuer</h3><p><b>(Ausschüttung + ausschüttungsgleiche Erträge) × 27,5 % − anrechenbare Quellensteuer</b></p><small>Das ist die Steuerschätzung. In FinanzOnline trägst du nicht diese Schätzung ein, sondern die zugrunde liegenden E1kv-Kennzahlen.</small></article><article><span>C</span><h3>Anschaffungskosten fortschreiben</h3><p><b>Ursprünglicher Kaufpreis + alle OeKB-AK-Korrekturen</b></p><small>Die AK-Korrektur ist keine zusätzliche FinanzOnline-Zeile. Sie verhindert, dass bereits versteuerte Fondserträge beim Verkauf nochmals als Gewinn besteuert werden.</small></article><article><span>D</span><h3>Gewinn oder Verlust beim Verkauf</h3><p><b>Verkaufserlös in EUR − fortgeschriebene Anschaffungskosten</b></p><small>Positiv geht der Betrag in KZ 994, negativ in KZ 892. Private Transaktionsspesen werden grundsätzlich nicht abgezogen.</small></article></div></section>

      <section className="tutorial-example"><div className="tutorial-section-heading light"><span>03</span><div><p className="eyebrow">Echter ETF · echte OeKB-Meldungen</p><h2>Vanguard FTSE All-World UCITS ETF (USD) Accumulating</h2><p><code>IE00BK5BQT80</code> · thesaurierender österreichischer KESt-Meldefonds. Die OeKB-Werte und historischen ECB-Kurse unten sind echt; Kauf und Verkauf sind ein klar gekennzeichnetes Musterdepot.</p></div></div><div className="real-data-badge"><span>OeKB-Melde-IDs</span><b>416424 · 488736 · 564233</b><a href="https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f?isin=IE00BK5BQT80" target="_blank" rel="noreferrer">Originaldaten öffnen ↗</a></div><div className="example-start"><span>Musterkauf · 01.02.2022</span><strong>10 Anteile × 95 € = 950 € steuerliche Anschaffungskosten</strong><p>Der Kauf ist angenommen. Für Privatvermögen wird hier grundsätzlich der reine Kaufpreis ohne Transaktionsspesen verwendet.</p></div><div className="example-timeline detailed">
        <article><div className="timeline-year"><b>2023</b><span>Meldung 26.01.</span></div><div><h3>OeKB-Jahresmeldung für 10 Anteile</h3><p>Fondswährung USD · echter Kurs: 0,917852 EUR/USD</p><div className="detail-calculations"><span><small>KZ 937 · agE</small><b>1,4369 × 10 × 0,917852 = 13,19 €</b></span><span><small>KZ 998 · Quellensteuer</small><b>0,1394 × 10 × 0,917852 = 1,28 €</b></span><span><small>Steuerschätzung</small><b>13,19 × 27,5 % − 1,28 = 2,35 €</b></span><span><small>AK-Korrektur</small><b>1,2334 × 10 × 0,917852 = +11,32 €</b></span></div></div><strong className="timeline-total">AK 961,32 €</strong></article>
        <article><div className="timeline-year"><b>2024</b><span>Meldung 18.01.</span></div><div><h3>Weiterhin 10 Anteile</h3><p>Fondswährung USD · echter Kurs: 0,919540 EUR/USD</p><div className="detail-calculations"><span><small>KZ 937 · agE</small><b>1,1676 × 10 × 0,919540 = 10,74 €</b></span><span><small>KZ 998 · Quellensteuer</small><b>0,1139 × 10 × 0,919540 = 1,05 €</b></span><span><small>Steuerschätzung</small><b>10,74 × 27,5 % − 1,05 = 1,90 €</b></span><span><small>AK-Korrektur</small><b>0,9226 × 10 × 0,919540 = +8,48 €</b></span></div></div><strong className="timeline-total">AK 969,80 €</strong></article>
        <article><div className="timeline-year"><b>2025</b><span>Meldung 15.01.</span></div><div><h3>Weiterhin 10 Anteile</h3><p>Fondswährung USD · echter Kurs: 0,970874 EUR/USD</p><div className="detail-calculations"><span><small>KZ 937 · agE</small><b>2,0861 × 10 × 0,970874 = 20,25 €</b></span><span><small>KZ 998 · Quellensteuer</small><b>0,1918 × 10 × 0,970874 = 1,86 €</b></span><span><small>Steuerschätzung</small><b>20,25 × 27,5 % − 1,86 = 3,71 €</b></span><span><small>AK-Korrektur</small><b>1,8377 × 10 × 0,970874 = +17,84 €</b></span></div></div><strong className="timeline-total">AK 987,65 €</strong></article>
        <article className="timeline-sale"><div className="timeline-year"><b>2025</b><span>Musterverkauf 03.02.</span></div><div><h3>Alle 10 Anteile für 1.300 USD verkauft</h3><p>Echter ECB-Kurs des Musterdatums: 0,973331 EUR/USD · Erlös: 1.265,33 €</p><div className="detail-calculations"><span><small>KZ 994 · Gewinn</small><b>1.265,33 − 987,65 = 277,68 €</b></span><span><small>Steuerschätzung Verkauf</small><b>277,68 × 27,5 % = 76,36 €</b></span><span><small>5 USD Verkaufsspesen</small><b>4,87 € nur dokumentieren, nicht abziehen</b></span></div></div><strong className="timeline-total">KZ 994<br />277,68 €</strong></article>
      </div><div className="example-formula"><span>Ursprüngliche AK</span><b>950,00 €</b><i>+</i><span>3 echte OeKB-Korrekturen</span><b>37,65 €</b><i>=</i><span>Fortgeschriebene AK</span><b>987,65 €</b></div><div className="example-note"><b>Warum steht KZ 898 jedes Jahr auf 0 €?</b><p>Dieser Anteil ist thesaurierend. Im Beispiel gab es laut den drei OeKB-Meldungen keine tatsächliche Ausschüttung je Anteil. Die Erträge bleiben im Fonds, sind als ausschüttungsgleiche Erträge aber trotzdem in KZ 937 steuerpflichtig.</p></div></section>

      <section className="tutorial-finanzonline"><div className="tutorial-section-heading"><span>04</span><div><p className="eyebrow">FinanzOnline und E1kv</p><h2>Was kommt wohin — und warum?</h2><p>Die E1kv ist die Beilage zur Einkommensteuererklärung für Kapitalerträge. Bei einem Auslandsbroker trägst du die Jahressummen aller betroffenen Depots und Fonds ein, nicht jede ISIN als eigene Formularzeile.</p></div></div><div className="finanzonline-map"><article><span className="kz">KZ 898</span><div><h3>Tatsächliche Fondsausschüttungen</h3><p>Hierhin kommt Geld, das der Fonds wirklich ausgeschüttet hat. Im VWCE-Beispiel: <b>0,00 €</b>, weil die verwendeten Meldungen keine Ausschüttung ausweisen.</p></div><em>laufender Ertrag</em></article><article><span className="kz">KZ 937</span><div><h3>Ausschüttungsgleiche Erträge</h3><p>Diese Erträge wurden im Fonds erwirtschaftet und dir steuerlich zugerechnet, obwohl kein Geld auf dein Konto kam. Beispiel 2025: <b>20,25 €</b>.</p></div><em>27,5 % Sondersteuersatz</em></article><article><span className="kz">KZ 998</span><div><h3>Anrechenbare ausländische Quellensteuer</h3><p>Nur der von der OeKB ausgewiesene anrechenbare Betrag. Er reduziert die österreichische Steuer. Beispiel 2025: <b>1,86 €</b>.</p></div><em>Steuergutschrift</em></article><article><span className="kz">KZ 994</span><div><h3>Realisierter Veräußerungsgewinn</h3><p>Verkaufserlös minus fortgeschriebene AK, wenn das Ergebnis positiv ist. Musterverkauf: <b>277,68 €</b>.</p></div><em>nur im Verkaufsjahr</em></article><article><span className="kz">KZ 892</span><div><h3>Realisierter Veräußerungsverlust</h3><p>Wenn dieselbe Rechnung negativ ist, kommt der absolute Verlust hierhin statt in KZ 994. Im Musterverkauf: <b>0,00 €</b>.</p></div><em>Verlustausgleich</em></article><article className="no-kz"><span className="kz">keine KZ</span><div><h3>Anschaffungskosten-Korrektur</h3><p>Nicht direkt in FinanzOnline eintragen. Du speicherst sie im Verlauf, damit beim späteren Verkauf nur der noch nicht versteuerte Gewinn erfasst wird.</p></div><em>für deine Evidenz</em></article></div><div className="finanzonline-steps"><b>Praktischer Ablauf in FinanzOnline</b><ol><li>Einkommensteuererklärung für das betreffende Kalenderjahr öffnen und die Beilage <strong>E1kv</strong> aktivieren.</li><li>Die vom Tool berechneten <strong>Jahressummen</strong> in KZ 898, 937, 994, 892 und 998 übernehmen.</li><li>Die Steuer selbst nicht als eigene Kennzahl eintragen: FinanzOnline berechnet sie aus den Einkünften und der anrechenbaren Quellensteuer.</li><li>OeKB-Meldungen, Depotauszüge, Brokerabrechnungen und CSV-Nachweis aufbewahren; grundsätzlich nur auf Aufforderung vorlegen.</li></ol></div></section>

      <section className="tutorial-glossary"><div className="tutorial-section-heading"><span>05</span><div><p className="eyebrow">Begriffe ohne Steuerdeutsch</p><h2>Nachschlagen, wenn etwas unklar ist</h2></div></div><div className="glossary-grid"><details open><summary>Meldefonds</summary><p>Ein Fonds, dessen steuerlicher Vertreter die vorgeschriebenen Steuerdaten fristgerecht an die OeKB meldet. Dadurch können die tatsächlichen Werte statt einer ungünstigeren Pauschalbesteuerung verwendet werden.</p></details><details><summary>Thesaurierend / Accumulating</summary><p>Erträge werden nicht ausbezahlt, sondern im Fonds wiederveranlagt. Steuerlich können trotzdem ausschüttungsgleiche Erträge entstehen.</p></details><details><summary>Meldetag</summary><p>Der Tag, an dem die OeKB-Jahresmeldung veröffentlicht wurde. Für das Tool zählt dein Bestand an genau diesem Tag; das Kalenderjahr des Meldetags bestimmt die Erklärung.</p></details><details><summary>Ausschüttungsgleiche Erträge (agE)</summary><p>Fondserträge, die dir steuerlich zugerechnet werden, obwohl du keine Auszahlung erhältst. Sie werden laufend besteuert und erhöhen über die AK-Korrektur deine spätere Kostenbasis.</p></details><details><summary>Anrechenbare Quellensteuer</summary><p>Ausländische Steuer innerhalb der Fondserträge, die laut OeKB auf die österreichische Steuer angerechnet werden darf. Nicht irgendeinen Betrag aus der Brokerabrechnung übernehmen.</p></details><details><summary>AK-Korrektur</summary><p>Änderung der steuerlichen Anschaffungskosten. Positive Werte erhöhen, negative vermindern die Kostenbasis. Sie beeinflusst den späteren Verkaufsgewinn, ist aber keine eigene E1kv-Zeile.</p></details><details><summary>EUR/FW-Kurs</summary><p>Euro-Wert einer Einheit Fremdwährung am maßgeblichen Tag. Bei 0,97 EUR/USD werden 1 USD mit 0,97 € angesetzt.</p></details><details><summary>E1kv und Kennzahl (KZ)</summary><p>E1kv ist die Kapitalerträge-Beilage zur Einkommensteuererklärung. Eine Kennzahl ist das nummerierte Zielfeld, in das eine bestimmte Art von Ertrag oder Steuer eingetragen wird.</p></details></div></section>

      <section className="tutorial-routine"><div className="tutorial-section-heading"><span>06</span><div><p className="eyebrow">Deine Checkliste</p><h2>Was du wann erledigst</h2></div></div><div className="routine-grid"><article><span>Jedes Jahr</span><ul><li>Position für das neue Steuerjahr öffnen oder hinzufügen</li><li>OeKB-Jahresmeldung automatisch laden</li><li>Stückzahl am angezeigten Meldetag prüfen</li><li>Berechnung im Portfolio speichern</li><li>E1kv-Jahressummen und CSV-Nachweis sichern</li></ul></article><article><span>Beim Verkauf</span><ul><li>Verkaufsdatum und Bruttoerlös in EUR oder USD eintragen</li><li>Automatischen Umrechnungskurs prüfen</li><li>Fortgeschriebene AK aus dem Verlauf übernehmen</li><li>Spesen nur dokumentieren, nicht vom privaten Gewinn abziehen</li><li>Positiven Gewinn in KZ 994 oder Verlust in KZ 892 erfassen</li></ul></article></div><aside><b>Bei Teilverkäufen</b><p>Nur die Anschaffungskosten und Jahreskorrekturen der tatsächlich verkauften Anteile verwenden. Die restlichen Anteile behalten ihre verbleibende Kostenbasis.</p></aside></section>

      <section className="tutorial-sources"><b>Verwendete Grundlagen</b><p>Historische Werte: öffentliche OeKB-Jahresmeldungen des Fonds. Formularzuordnung: E1kv. Rechtliche Details und Einzelfälle können sich ändern — aktuelles Formular und fachkundige Beratung gehen vor.</p><div><a href="https://www.oekb.at/kapitalmarkt-services/unser-datenangebot/fonds/steuerdaten.html" target="_blank" rel="noreferrer">OeKB-Steuerdaten ↗</a><a href="https://service.bmf.gv.at/service/anwend/formulare/show_mast.asp?Typ=SM&__ClFRM_STICHW_ALL=E1kv" target="_blank" rel="noreferrer">Aktuelles BMF E1kv ↗</a><a href="https://findok.bmf.gv.at/findok/?dokumentId=b85f1a99-5c1f-488b-b94a-5ac662824f68&execution=e100000s1" target="_blank" rel="noreferrer">BMF Investmentfondsrichtlinien ↗</a></div></section>

      <section className="tutorial-finish"><span>✓</span><div><h2>Du bist bereit.</h2><p>Das Tutorial kannst du später jederzeit über „Tutorial“ in der Navigation erneut öffnen.</p></div><button type="button" onClick={onClose}>Zum ETF-Rechner →</button></section>
    </div>
  </section>;
}

export default function EtfTaxAssistant() {
  const [showTutorial, setShowTutorial] = useState(true);
  const [identifier, setIdentifier] = useState("IE00B4L5Y983");
  const [taxYear, setTaxYear] = useState(currentTaxYear);
  const [status, setStatus] = useState<FundStatus>("reporting");
  const [values, setValues] = useState<Values>(initialValues);
  const [security, setSecurity] = useState<Security | null>(null);
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [showSale, setShowSale] = useState(false);
  const [saleCurrency, setSaleCurrency] = useState<SaleCurrency>("EUR");
  const [saleDate, setSaleDate] = useState("");
  const [saleFxState, setSaleFxState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [saleFxInfo, setSaleFxInfo] = useState<{ date?: string; source?: string; error?: string } | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [pastedOekb, setPastedOekb] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [saveGeminiKey, setSaveGeminiKey] = useState(true);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [importState, setImportState] = useState<"idle" | "extracting" | "done" | "error">("idle");
  const [importResult, setImportResult] = useState<OekbExtraction | null>(null);
  const [importError, setImportError] = useState("");
  const [oekbState, setOekbState] = useState<"idle" | "loading" | "done" | "missing" | "error">("idle");
  const [oekbResult, setOekbResult] = useState<AutomaticOekbResult | null>(null);
  const [oekbError, setOekbError] = useState("");
  const [pendingOekbInfo, setPendingOekbInfo] = useState<PendingOekbInfo | null>(null);
  const [retryingPositionId, setRetryingPositionId] = useState<string | null>(null);
  const [ownershipStatus, setOwnershipStatus] = useState<OwnershipStatus>("held");
  const [portfolio, setPortfolio] = useState<PortfolioEntry[]>([]);
  const [transactions, setTransactions] = useState<BrokerTransaction[]>([]);
  const [pdfImportState, setPdfImportState] = useState<"idle" | "reading" | "done" | "error">("idle");
  const [pdfImportMessage, setPdfImportMessage] = useState("");
  const [dataMessage, setDataMessage] = useState("");
  const [activePositionId, setActivePositionId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem("etf-steuerassistent-at");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { identifier?: string; taxYear?: string; status?: FundStatus; values?: Values; ownershipStatus?: OwnershipStatus; portfolio?: PortfolioEntry[]; transactions?: BrokerTransaction[]; activePositionId?: string | null; showSale?: boolean; saleCurrency?: SaleCurrency; saleDate?: string };
          if (parsed.identifier) setIdentifier(parsed.identifier);
          if (parsed.taxYear) setTaxYear(parsed.taxYear);
          if (parsed.status) setStatus(parsed.status);
          if (parsed.values) setValues({ ...initialValues, ...parsed.values });
          if (parsed.ownershipStatus) setOwnershipStatus(parsed.ownershipStatus);
          if (Array.isArray(parsed.portfolio)) setPortfolio(parsed.portfolio.map((entry) => ({ ...entry, values: { ...initialValues, ...entry.values }, saleCurrency: entry.saleCurrency ?? "EUR", saleDate: entry.saleDate ?? "" })));
          if (Array.isArray(parsed.transactions)) setTransactions(parsed.transactions);
          if (parsed.activePositionId) setActivePositionId(parsed.activePositionId);
          if (parsed.showSale) setShowSale(true);
          if (parsed.saleCurrency) setSaleCurrency(parsed.saleCurrency);
          if (parsed.saleDate) setSaleDate(parsed.saleDate);
        } catch { /* Ignore broken local drafts. */ }
      }
      setGeminiKey(localStorage.getItem("etf-steuer-gemini-key") ?? "");
      setShowTutorial(localStorage.getItem("etf-steuer-tutorial-seen-v2") !== "1");
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("etf-steuerassistent-at", JSON.stringify({ identifier, taxYear, status, values, ownershipStatus, portfolio, transactions, activePositionId, showSale, saleCurrency, saleDate }));
  }, [identifier, taxYear, status, values, ownershipStatus, portfolio, transactions, activePositionId, showSale, saleCurrency, saleDate, hydrated]);
  useEffect(() => {
    if (saveGeminiKey && geminiKey) localStorage.setItem("etf-steuer-gemini-key", geminiKey);
    else if (!saveGeminiKey) localStorage.removeItem("etf-steuer-gemini-key");
  }, [geminiKey, saveGeminiKey]);
  useEffect(() => {
    if (!showTutorial) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [showTutorial]);

  const result = useMemo(() => calculateEtfTax({
    status,
    ...values,
    saleProceeds: showSale ? values.saleProceeds : 0,
    saleCostBasis: showSale ? values.saleCostBasis : 0,
    saleFees: showSale ? values.saleFees : 0,
    saleFxRate: showSale && saleCurrency === "USD" ? values.saleFxRate : 1,
  }), [status, values, showSale, saleCurrency]);
  const portfolioForYear = useMemo(() => portfolio.filter((entry) => entry.taxYear === taxYear), [portfolio, taxYear]);
  const currentYearPortfolio = useMemo(() => portfolio.filter((entry) => entry.taxYear === currentTaxYear), [portfolio]);
  const currentYearPending = useMemo(() => currentYearPortfolio.filter((entry) => entry.reportTracking?.state === "pending"), [currentYearPortfolio]);
  const currentYearAvailable = currentYearPortfolio.length - currentYearPending.length;
  const currentHoldings = useMemo(() => selectLatestHeldPositions(portfolio)
    .sort((a, b) => (a.security?.name ?? a.identifier).localeCompare(b.security?.name ?? b.identifier)), [portfolio]);
  const currentYearTotals = useMemo(() => currentYearPortfolio
    .filter((entry) => entry.reportTracking?.state !== "pending")
    .reduce((totals, entry) => ({
      estimatedTax: totals.estimatedTax + entry.result.estimatedTax,
      taxableTotal: totals.taxableTotal + entry.result.taxableTotal,
    }), { estimatedTax: 0, taxableTotal: 0 }), [currentYearPortfolio]);
  const pendingForYear = useMemo(() => portfolioForYear.filter((entry) => entry.reportTracking?.state === "pending"), [portfolioForYear]);
  const readyForYear = useMemo(() => portfolioForYear.filter((entry) => entry.reportTracking?.state !== "pending"), [portfolioForYear]);
  const portfolioTotals = useMemo(() => readyForYear.reduce((totals, entry) => ({
    estimatedTax: totals.estimatedTax + entry.result.estimatedTax,
    taxableTotal: totals.taxableTotal + entry.result.taxableTotal,
    kz898: totals.kz898 + entry.result.kz898,
    kz937: totals.kz937 + entry.result.kz937,
    kz994: totals.kz994 + entry.result.kz994,
    kz892: totals.kz892 + entry.result.kz892,
    kz998: totals.kz998 + entry.result.kz998,
  }), { estimatedTax: 0, taxableTotal: 0, kz898: 0, kz937: 0, kz994: 0, kz892: 0, kz998: 0 }), [readyForYear]);
  const filingResult = readyForYear.length > 0 ? portfolioTotals : result;
  const oekbUrl = identifier.length === 12 ? `https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f?isin=${encodeURIComponent(identifier)}` : "https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f";
  const perUnitCurrency = oekbResult?.currency ?? importResult?.currency ?? "FW";
  const activeImport = oekbState === "done" ? oekbResult : importState === "done" ? importResult : null;
  const formattedReportDate = formatReportDate(activeImport?.reportDate);
  const normalizedIdentifier = identifier.trim().toUpperCase();
  const transactionBalances = useMemo(() => currentUnitsByIsin(transactions), [transactions]);
  const brokerUnitsAtReport = activeImport?.reportDate && normalizedIdentifier.length === 12
    ? unitsAtDate(transactions, normalizedIdentifier, activeImport.reportDate) : null;
  const importedValue = (value: number | null | undefined) => activeImport !== null && value !== null && value !== undefined;
  const unitsComplete = values.units > 0;
  const previewReady = unitsComplete && (status === "non-reporting" || activeImport !== null);
  const reportStillMissing = oekbState === "missing" && importState !== "done";
  const correctionHistory = (() => {
    const corrections: Array<CostBasisCorrection & { id: string; source: "saved" | "current" }> = portfolio
      .filter((entry) => entry.identifier === normalizedIdentifier && entry.status === "reporting" && entry.reportTracking?.state !== "pending")
      .map((entry) => ({
        id: entry.id,
        taxYear: entry.taxYear,
        reportDate: entry.oekbResult?.reportDate ?? entry.importResult?.reportDate ?? null,
        amount: entry.id === activePositionId ? result.costAdjustment : entry.result.costAdjustment,
        source: entry.id === activePositionId ? "current" as const : "saved" as const,
      }));
    if (!activePositionId && normalizedIdentifier && unitsComplete && activeImport?.reportDate) {
      corrections.push({ id: "current-preview", taxYear, reportDate: activeImport.reportDate, amount: result.costAdjustment, source: "current" });
    }
    return corrections.sort((a, b) => (a.reportDate ?? a.taxYear).localeCompare(b.reportDate ?? b.taxYear));
  })();
  const costBasisLedger = calculateCorrectedCostBasis(values.baseAcquisitionCost, correctionHistory, showSale && saleDate ? saleDate : undefined);
  const saleRate = saleCurrency === "USD" ? values.saleFxRate || 1 : 1;
  const convertedSaleProceeds = values.saleProceeds * saleRate;
  const convertedSaleFees = values.saleFees * saleRate;
  const setField = (field: NumberField, value: number) => setValues((current) => ({ ...current, [field]: value }));

  function downloadFile(content: BlobPart, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportBackup() {
    const raw = createAppBackup({ identifier, taxYear, status, values, ownershipStatus, portfolio, activePositionId, showSale, saleCurrency, saleDate, transactions });
    downloadFile(raw, `ETF-Steuer-Backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json;charset=utf-8");
    setDataMessage("✓ Vollständiges JSON-Backup erstellt.");
  }

  async function importBackup(file: File | undefined) {
    if (!file) return;
    try {
      const backup = parseAppBackup<PortfolioEntry, Values>(await file.text());
      if (!window.confirm(`Backup mit ${backup.data.portfolio.length} ETF-Einträgen und ${backup.data.transactions.length} Transaktionen laden? Die aktuellen lokalen Daten werden ersetzt.`)) return;
      const data = backup.data;
      setIdentifier(data.identifier); setTaxYear(data.taxYear); setStatus(data.status); setValues({ ...initialValues, ...data.values });
      setOwnershipStatus(data.ownershipStatus); setPortfolio(data.portfolio.map((entry) => ({ ...entry, values: { ...initialValues, ...entry.values } })));
      setTransactions(data.transactions); setActivePositionId(data.activePositionId); setShowSale(data.showSale); setSaleCurrency(data.saleCurrency); setSaleDate(data.saleDate);
      setDataMessage(`✓ Backup vom ${formatShortDate(backup.exportedAt.slice(0, 10)) ?? backup.exportedAt} wiederhergestellt.`);
    } catch (error) { setDataMessage(`Import nicht möglich: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`); }
  }

  function exportExcel() {
    const workbook = buildPortfolioWorkbook(portfolio, transactions);
    const bytes = new ArrayBuffer(workbook.byteLength);
    new Uint8Array(bytes).set(workbook);
    downloadFile(bytes, `ETF-Steuer-Uebersicht-${new Date().toISOString().slice(0, 10)}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    setDataMessage("✓ Excel-Übersicht mit Steuerjahren, ETF-Daten und Transaktionen erstellt.");
  }

  async function importBrokerPdfs(files: FileList | null) {
    if (!files?.length) return;
    setPdfImportState("reading"); setPdfImportMessage(`${files.length} PDF-Datei${files.length === 1 ? "" : "en"} wird lokal gelesen …`);
    try {
      const imported: BrokerTransaction[] = [];
      const warnings: string[] = [];
      for (const file of Array.from(files)) {
        if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { warnings.push(`${file.name}: keine PDF-Datei`); continue; }
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const sourceId = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const extractedPdf = await extractPdfText(file);
        const parsed = parseBrokerPdfText(extractedPdf.text, file.name);
        parsed.transactions.forEach((transaction, index) => imported.push({ ...transaction, id: `${sourceId}-${index}`, sourceId, importedAt: new Date().toISOString() }));
        warnings.push(...parsed.warnings.map((warning) => `${file.name}: ${warning}`));
      }
      setTransactions((current) => {
        const known = new Set(current.map((item) => item.id));
        const fresh = imported.filter((item) => !known.has(item.id));
        return [...current, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
      });
      const uniqueIsins = [...new Set(imported.flatMap((item) => item.isin ? [item.isin] : []))];
      if (!identifier.trim() && uniqueIsins.length === 1) setIdentifier(uniqueIsins[0]);
      if (activeImport?.reportDate && normalizedIdentifier.length === 12 && values.units === 0) {
        const inferred = unitsAtDate([...transactions, ...imported], normalizedIdentifier, activeImport.reportDate);
        if (inferred.units > 0) setField("units", inferred.units);
      }
      setPdfImportState("done");
      setPdfImportMessage(`${imported.length} Transaktion${imported.length === 1 ? "" : "en"} erkannt${warnings.length ? ` · ${warnings.length} Prüfhinweis${warnings.length === 1 ? "" : "e"}` : ""}. Doppelte Dateien werden beim erneuten Import übersprungen.`);
    } catch (error) {
      setPdfImportState("error"); setPdfImportMessage(error instanceof Error ? error.message : "PDF-Import fehlgeschlagen.");
    }
  }

  function closeTutorial() {
    localStorage.setItem("etf-steuer-tutorial-seen-v2", "1");
    setShowTutorial(false);
  }

  function resetEditor() {
    setIdentifier(""); setTaxYear(currentTaxYear); setStatus("reporting"); setValues(initialValues);
    setSecurity(null); setLookupState("idle"); setShowSale(false); setSaleCurrency("EUR"); setSaleDate(""); setSaleFxState("idle"); setSaleFxInfo(null); setShowResults(false);
    setPastedOekb(""); setImportState("idle"); setImportResult(null); setImportError("");
    setOekbState("idle"); setOekbResult(null); setOekbError(""); setPendingOekbInfo(null); setOwnershipStatus("held"); setActivePositionId(null);
  }

  function startNewPosition() {
    resetEditor();
    window.setTimeout(() => document.querySelector("#rechner")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function editPosition(entry: PortfolioEntry) {
    setIdentifier(entry.identifier); setTaxYear(entry.taxYear); setStatus(entry.status); setValues({ ...initialValues, ...entry.values });
    setSecurity(entry.security); setLookupState(entry.security ? "done" : "idle"); setShowSale(entry.showSale); setSaleCurrency(entry.saleCurrency ?? "EUR"); setSaleDate(entry.saleDate ?? ""); setSaleFxState(entry.saleCurrency === "USD" && entry.values.saleFxRate ? "done" : "idle"); setSaleFxInfo(null); setShowResults(entry.reportTracking?.state !== "pending");
    setImportResult(entry.importResult); setImportState(entry.importResult ? "done" : "idle"); setImportError("");
    setOekbResult(entry.oekbResult); setOekbState(entry.oekbResult ? "done" : entry.reportTracking?.state === "pending" ? "missing" : "idle");
    setOekbError(entry.reportTracking?.message ?? "");
    setPendingOekbInfo(entry.reportTracking?.state === "pending" ? { error: entry.reportTracking.message ?? "Für dieses Steuerjahr liegt noch keine Jahresmeldung vor.", availableYears: [], reportHistory: entry.reportTracking.reportHistory, prediction: entry.reportTracking.prediction } : null);
    setOwnershipStatus(entry.ownershipStatus); setActivePositionId(entry.id);
    document.querySelector("#rechner")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function savePosition() {
    if (!unitsComplete || !identifier.trim()) return;
    const normalizedIdentifier = identifier.trim().toUpperCase();
    setPortfolio((current) => {
      const existing = activePositionId
        ? current.find((entry) => entry.id === activePositionId)
        : current.find((entry) => entry.identifier === normalizedIdentifier && entry.taxYear === taxYear);
      const id = existing?.id ?? `etf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const entry: PortfolioEntry = {
        id, identifier: normalizedIdentifier, taxYear, status, ownershipStatus, values: { ...values }, security,
        oekbResult, importResult, showSale, saleCurrency, saleDate, result,
        reportTracking: oekbResult ? { state: "available", lastCheckedAt: new Date().toISOString(), message: null, reportHistory: oekbResult.reportHistory, prediction: oekbResult.prediction } : existing?.reportTracking,
        savedAt: new Date().toISOString(),
      };
      setActivePositionId(id);
      return existing ? current.map((item) => item.id === id ? entry : item) : [...current, entry];
    });
    setShowResults(true);
  }

  function removePosition(entry: PortfolioEntry) {
    if (!window.confirm(`${entry.security?.name ?? entry.identifier} wirklich aus dem Portfolio entfernen?`)) return;
    setPortfolio((current) => current.filter((item) => item.id !== entry.id));
    if (activePositionId === entry.id) resetEditor();
  }

  function trackPendingReport(normalizedIdentifier: string, requestedTaxYear: string, info: PendingOekbInfo) {
    if (requestedTaxYear !== currentTaxYear) return;
    const checkedAt = new Date().toISOString();
    setPortfolio((current) => {
      const existing = current.find((entry) => entry.identifier === normalizedIdentifier && entry.taxYear === requestedTaxYear);
      const id = existing?.id ?? `etf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const pendingValues = existing?.values ?? { ...initialValues };
      const entry: PortfolioEntry = {
        id,
        identifier: normalizedIdentifier,
        taxYear: requestedTaxYear,
        status: existing?.status ?? "reporting",
        ownershipStatus: existing?.ownershipStatus ?? ownershipStatus,
        values: pendingValues,
        security: existing?.security ?? (security?.identifier === normalizedIdentifier ? security : null),
        oekbResult: null,
        importResult: existing?.importResult ?? null,
        showSale: existing?.showSale ?? false,
        saleCurrency: existing?.saleCurrency ?? "EUR",
        saleDate: existing?.saleDate ?? "",
        result: existing?.result ?? calculateSnapshot("reporting", pendingValues, false),
        reportTracking: { state: "pending", lastCheckedAt: checkedAt, message: info.error, reportHistory: info.reportHistory, prediction: info.prediction },
        savedAt: existing?.savedAt ?? checkedAt,
      };
      setActivePositionId(id);
      return existing ? current.map((item) => item.id === id ? entry : item) : [...current, entry];
    });
  }

  async function addEurRate(extracted: OekbExtraction): Promise<OekbExtraction> {
    if (extracted.eurRate !== null || !extracted.currency || !extracted.reportDate) return extracted;
    const response = await fetch(`/api/fx?currency=${encodeURIComponent(extracted.currency)}&date=${encodeURIComponent(extracted.reportDate)}`);
    const fx = await response.json() as { rate?: number; date?: string; source?: string };
    if (!response.ok || typeof fx.rate !== "number") {
      return { ...extracted, warnings: [...extracted.warnings, "Der EUR-Umrechnungskurs konnte nicht automatisch ergänzt werden. Vor der Berechnung bitte manuell prüfen."] };
    }
    return {
      ...extracted,
      eurRate: fx.rate,
      exchangeRateDate: fx.date,
      exchangeRateSource: fx.source,
      warnings: [...extracted.warnings, "Der verwendete ECB-Referenzkurs ist vor Abgabe mit der steuerlich maßgeblichen Umrechnungsmethode zu prüfen."],
    };
  }

  async function loadSaleFxRate(requestedDate = saleDate) {
    if (saleCurrency === "EUR") {
      setField("saleFxRate", 1);
      setSaleFxState("done");
      setSaleFxInfo({ date: requestedDate || undefined, source: "EUR-Betrag – keine Umrechnung" });
      return;
    }
    if (!requestedDate) {
      setSaleFxState("error");
      setSaleFxInfo({ error: "Bitte zuerst das Verkaufsdatum eingeben." });
      return;
    }
    setSaleFxState("loading"); setSaleFxInfo(null);
    try {
      const response = await fetch(`/api/fx?currency=USD&date=${encodeURIComponent(requestedDate)}`);
      const data = await response.json() as { rate?: number; date?: string; source?: string; error?: string };
      if (!response.ok || typeof data.rate !== "number") throw new Error(data.error ?? "USD-Kurs konnte nicht geladen werden.");
      setField("saleFxRate", data.rate);
      setSaleFxState("done");
      setSaleFxInfo({ date: data.date, source: data.source });
    } catch (error) {
      setSaleFxState("error");
      setSaleFxInfo({ error: error instanceof Error ? error.message : "USD-Kurs konnte nicht geladen werden." });
    }
  }

  async function loadOekbData(normalizedIdentifier = identifier.trim().toUpperCase(), requestedTaxYear = taxYear) {
    if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(normalizedIdentifier)) {
      setOekbError("Der automatische OeKB-Abruf benötigt eine 12-stellige ISIN; eine WKN reicht dafür nicht.");
      setOekbState("error");
      return null;
    }
    setOekbState("loading"); setOekbError(""); setOekbResult(null); setPendingOekbInfo(null); setShowResults(false);
    try {
      const response = await fetch(`/api/oekb?isin=${encodeURIComponent(normalizedIdentifier)}&taxYear=${encodeURIComponent(requestedTaxYear)}`);
      const data = await response.json() as AutomaticOekbResult & PendingOekbInfo;
      if (!response.ok) {
        if (response.status === 404 && requestedTaxYear === currentTaxYear) {
          const pending = { error: data.error ?? `Für ${requestedTaxYear} wurde noch keine OeKB-Jahresmeldung gefunden.`, availableYears: data.availableYears ?? [], reportHistory: data.reportHistory ?? [], prediction: data.prediction ?? null };
          setPendingOekbInfo(pending); setOekbError(pending.error); setOekbState("missing");
          trackPendingReport(normalizedIdentifier, requestedTaxYear, pending);
          return null;
        }
        throw new Error(data.error ?? "OeKB-Abruf fehlgeschlagen.");
      }
      const enriched = await addEurRate(data) as AutomaticOekbResult;
      applyExtraction(enriched);
      setOekbResult(enriched);
      setPendingOekbInfo(null);
      setOekbState("done");
      const foundSecurity: Security = {
        identifier: normalizedIdentifier,
        identifierType: "ISIN",
        name: enriched.fundName,
        ticker: null,
        exchange: null,
        verified: true,
      };
      setSecurity(foundSecurity);
      setPortfolio((current) => current.map((entry) => {
        if (entry.identifier !== normalizedIdentifier || entry.taxYear !== requestedTaxYear || entry.reportTracking?.state !== "pending") return entry;
        const nextValues = valuesWithExtraction(entry.values, enriched);
        return {
          ...entry,
          values: nextValues,
          security: foundSecurity,
          oekbResult: enriched,
          result: calculateSnapshot(entry.status, nextValues, entry.showSale, entry.saleCurrency ?? "EUR"),
          reportTracking: { state: "available", lastCheckedAt: new Date().toISOString(), message: null, reportHistory: enriched.reportHistory, prediction: enriched.prediction },
        };
      }));
      return enriched;
    } catch (error) {
      setOekbError(error instanceof Error ? error.message : "OeKB-Abruf fehlgeschlagen.");
      setOekbState("error");
      return null;
    }
  }

  async function lookup(event: FormEvent) {
    event.preventDefault();
    const normalized = identifier.trim().toUpperCase();
    setIdentifier(normalized); setLookupState("loading"); setShowResults(false);
    if (values.baseAcquisitionCost <= 0) {
      const priorBase = portfolio.find((entry) => entry.identifier === normalized && entry.values.baseAcquisitionCost > 0)?.values.baseAcquisitionCost;
      if (priorBase) setField("baseAcquisitionCost", priorBase);
    }
    const securityPromise = fetch("/api/security", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: normalized }) })
      .then(async (response) => {
        const data = await response.json() as Security & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Lookup fehlgeschlagen");
        return data;
      });
    const [oekbLookup, securityResult] = await Promise.allSettled([loadOekbData(normalized), securityPromise]);
    if (securityResult.status === "fulfilled") {
      setSecurity(securityResult.value);
      setPortfolio((current) => current.map((entry) => entry.identifier === normalized && entry.taxYear === taxYear && entry.reportTracking?.state === "pending" ? { ...entry, security: securityResult.value } : entry));
    }
    else if (oekbLookup.status !== "fulfilled" || !oekbLookup.value) setSecurity(null);
    setLookupState(securityResult.status === "fulfilled" || /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(normalized) ? "done" : "error");
  }

  function applyExtraction(extracted: OekbExtraction) {
    const extractedIsin = (extracted.isin ?? identifier).trim().toUpperCase();
    const inferred = extracted.reportDate && extractedIsin.length === 12 ? unitsAtDate(transactions, extractedIsin, extracted.reportDate) : null;
    setValues((current) => ({ ...valuesWithExtraction(current, extracted), units: current.units === 0 && inferred && inferred.units > 0 ? inferred.units : current.units }));
    if (extracted.isin) setIdentifier(extractedIsin);
    if (extracted.reportDate) setTaxYear(extracted.reportDate.slice(0, 4));
    setStatus("reporting");
    setShowResults(false);
  }

  async function retryPendingPosition(entry: PortfolioEntry) {
    setRetryingPositionId(entry.id);
    editPosition(entry);
    await loadOekbData(entry.identifier, entry.taxYear);
    setRetryingPositionId(null);
  }

  async function importOekbData() {
    if (pastedOekb.trim().length < 80) { setImportError("Bitte kopiere die vollständige OeKB-Seite oder zumindest die Meldetabelle hinein."); setImportState("error"); return; }
    setImportState("extracting"); setImportError(""); setImportResult(null);
    const local = parseOekbTextLocally(pastedOekb);
    try {
      let extracted: OekbExtraction;
      if (geminiKey.trim()) {
        const ai = await extractWithGemini(geminiKey.trim(), pastedOekb);
        extracted = {
          ...local, ...ai,
          isin: ai.isin ?? local.isin, currency: ai.currency ?? local.currency, reportDate: ai.reportDate ?? local.reportDate,
          eurRate: ai.eurRate ?? local.eurRate,
          actualDistributionPerUnit: ai.actualDistributionPerUnit ?? local.actualDistributionPerUnit,
          deemedIncomePerUnit: ai.deemedIncomePerUnit ?? local.deemedIncomePerUnit,
          creditableForeignTaxPerUnit: ai.creditableForeignTaxPerUnit ?? local.creditableForeignTaxPerUnit,
          costBasisAdjustmentPerUnit: ai.costBasisAdjustmentPerUnit ?? local.costBasisAdjustmentPerUnit,
          evidence: { ...local.evidence, ...ai.evidence }, warnings: [...local.warnings, ...(ai.warnings ?? [])], model: ai.model,
        };
      } else {
        extracted = { ...local, warnings: [...local.warnings, "Ohne Gemini-Key wurde nur die konservative lokale Erkennung verwendet."] };
      }

      extracted = await addEurRate(extracted);

      const found = [extracted.actualDistributionPerUnit, extracted.deemedIncomePerUnit, extracted.creditableForeignTaxPerUnit, extracted.costBasisAdjustmentPerUnit].filter((value) => value !== null).length;
      if (found === 0) throw new Error("Keine der vier Steuerkennzahlen wurde eindeutig erkannt. Bitte mehr Inhalt kopieren oder Gemini verwenden.");
      setImportResult(extracted); applyExtraction(extracted); setImportState("done");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import fehlgeschlagen."); setImportState("error");
    }
  }

  function copyValue(code: string, amount: number) {
    navigator.clipboard?.writeText(amount.toFixed(2).replace(".", ",")); setCopied(code); window.setTimeout(() => setCopied(null), 1200);
  }

  function downloadCsv() {
    const rows: Array<Array<string | number>> = [["ETF-Steuerassistent Österreich", ""], ["Steuerjahr", taxYear]];
    if (portfolioForYear.length > 0) {
      rows.push([], ["Portfolio-Positionen", portfolioForYear.length], ["ISIN", "ETF", "Status", "Stück am Meldetag", "Meldetag", "AK-Korrektur", "Ursprüngliche AK", "Verkaufswährung", "Verkaufsdatum", "Verkaufskurs EUR/FW", "Verkaufsspesen (nicht abziehbar)", "Steuerschätzung"]);
      for (const entry of portfolioForYear) rows.push([
        entry.identifier,
        entry.security?.name ?? entry.oekbResult?.fundName ?? "",
        entry.reportTracking?.state === "pending" ? "OeKB-Meldung ausständig" : entry.ownershipStatus === "held" ? "Im Bestand" : "Verkauft",
        entry.reportTracking?.state === "pending" && entry.values.units === 0 ? "" : entry.values.units,
        entry.oekbResult?.reportDate ?? entry.importResult?.reportDate ?? "",
        entry.reportTracking?.state === "pending" ? "" : entry.result.costAdjustment.toFixed(2),
        entry.values.baseAcquisitionCost.toFixed(2),
        entry.showSale ? entry.saleCurrency ?? "EUR" : "",
        entry.showSale ? entry.saleDate ?? "" : "",
        entry.showSale ? (entry.saleCurrency === "USD" ? entry.values.saleFxRate : 1).toFixed(6) : "",
        entry.showSale ? entry.values.saleFees.toFixed(2) : "",
        entry.reportTracking?.state === "pending" ? "" : entry.result.estimatedTax.toFixed(2),
      ]);
      rows.push([]);
    } else {
      rows.push(["Kennung", identifier], ["ETF", security?.name ?? ""]);
    }
    rows.push(["E1kv KZ 898", filingResult.kz898.toFixed(2)], ["E1kv KZ 937", filingResult.kz937.toFixed(2)], ["E1kv KZ 994", filingResult.kz994.toFixed(2)], ["E1kv KZ 892", filingResult.kz892.toFixed(2)], ["E1kv KZ 998", filingResult.kz998.toFixed(2)], ["Geschätzte Steuer", filingResult.estimatedTax.toFixed(2)]);
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = portfolioForYear.length > 0 ? `ETF-Portfolio-Steuer-${taxYear}.csv` : `ETF-Steuer-${taxYear}-${identifier || "Auswertung"}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <>{showTutorial && <Tutorial onClose={closeTutorial} />}<main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="ETF-Steuerassistent Übersicht"><span className="brand-mark">AT</span><span><strong>ETF-Steuer</strong><small>Assistent Österreich</small></span></a>
      <nav aria-label="Hauptnavigation"><a href="#top">Übersicht</a><a href="#rechner">ETF berechnen</a><a href="#finanzonline">FinanzOnline</a><button type="button" onClick={() => setShowTutorial(true)}>Hilfe & Beispiel</button></nav>
      <span className="privacy-pill"><span /> Nur lokal gespeichert</span>
    </header>

    <section className="dashboard" id="top">
      <div className="dashboard-heading"><div><p className="eyebrow">Dein Steuer-Dashboard · {currentTaxYear}</p><h1>Was ist bei deinen ETFs <em>jetzt zu tun?</em></h1><p>Hier siehst du deine aktuellen Holdings, offene OeKB-Meldungen und die bisher geschätzte Steuer. Für eine neue Berechnung brauchst du zuerst nur die ISIN.</p></div><button className="dashboard-add" type="button" onClick={startNewPosition}><span>＋</span> ETF hinzufügen</button></div>

      <div className="dashboard-stats" aria-label="Überblick zum aktuellen Steuerjahr">
        <article><span className="stat-icon holdings">◆</span><div><small>Aktuelle Holdings <Info>Pro ISIN wird die zuletzt gespeicherte, noch gehaltene Position angezeigt.</Info></small><strong>{currentHoldings.length}</strong><em>{currentHoldings.length === 1 ? "ETF im Bestand" : "ETFs im Bestand"}</em></div></article>
        <article className={currentYearPending.length ? "needs-attention" : ""}><span className="stat-icon reports">◷</span><div><small>OeKB-Meldungen <Info>Die OeKB veröffentlicht die steuerlichen Jahreswerte eines Meldefonds. Fehlt die Meldung noch, bleibt der ETF vorgemerkt.</Info></small><strong>{currentYearPending.length}</strong><em>{currentYearPending.length ? "noch zu prüfen" : "aktuell nichts offen"}</em></div></article>
        <article><span className="stat-icon tax">€</span><div><small>Steuerschätzung {currentTaxYear} <Info>Unverbindliche Schätzung mit 27,5 % Sondersteuersatz abzüglich anrechenbarer Quellensteuer.</Info></small><strong>{eur.format(currentYearTotals.estimatedTax)}</strong><em>aus {currentYearAvailable} berechneten Meldungen</em></div></article>
        <article><span className="stat-icon filing">✓</span><div><small>Status FinanzOnline <Info>Bereit bedeutet: Alle derzeit gespeicherten Positionen für dieses Jahr haben eine verfügbare Meldung. Vor Abgabe trotzdem Belege prüfen.</Info></small><strong className="status-word">{currentYearPortfolio.length === 0 ? "Starten" : currentYearPending.length ? "Offen" : "Bereit"}</strong><em>{currentYearPortfolio.length === 0 ? "ersten ETF hinzufügen" : currentYearPending.length ? `${currentYearPending.length} Meldung${currentYearPending.length === 1 ? "" : "en"} fehlt` : "Jahressummen verfügbar"}</em></div></article>
      </div>

      <section className="data-center" aria-labelledby="data-center-title">
        <div className="data-center-heading"><div><span className="mini-kicker">Sichern · übertragen · automatisch erfassen</span><h2 id="data-center-title">Deine Datenzentrale</h2><p>PDFs bleiben auf diesem Gerät. Backup und Excel enthalten deine Steuerdaten und sollten sicher aufbewahrt werden.</p></div><span className="local-processing">🔒 lokale Verarbeitung</span></div>
        <div className="data-tools">
          <article className="data-tool pdf-tool"><span className="tool-icon">PDF</span><div><h3>Broker-Abrechnungen importieren</h3><p>Broker-PDFs für Käufe, Verkäufe, Dividenden, Steuern, Gebühren und Depotüberträge einlesen. Bestandswirksame Belege werden automatisch für den OeKB-Meldetag berücksichtigt.</p><label className="file-action primary-file">PDFs auswählen<input type="file" accept="application/pdf,.pdf" multiple onChange={(event) => { void importBrokerPdfs(event.target.files); event.target.value = ""; }} /></label></div><em>PP-artige Erkennung · u. a. Flatex, Scalable/Baader, Trade Republic, DEGIRO, IBKR und DADAT</em></article>
          <article className="data-tool"><span className="tool-icon">JSON</span><div><h3>Vollständiges Backup</h3><p>Alle ETF-Jahre, Meldungen, Rechnerwerte und importierten Transaktionen exportieren oder auf einem anderen Gerät wiederherstellen.</p><div className="tool-actions"><button type="button" onClick={exportBackup}>Backup exportieren</button><label className="file-action">Backup importieren<input type="file" accept="application/json,.json" onChange={(event) => { void importBackup(event.target.files?.[0]); event.target.value = ""; }} /></label></div></div><em>Der Gemini-Key wird aus Sicherheitsgründen nie exportiert.</em></article>
          <article className="data-tool"><span className="tool-icon">XLSX</span><div><h3>Excel-Übersicht</h3><p>Übersichtliche Arbeitsmappe mit E1kv-Jahressummen, sämtlichen ETF-Steuerdaten und einer separaten Transaktionsliste.</p><button type="button" onClick={exportExcel}>Excel herunterladen</button></div><em>Blätter: Übersicht · ETF-Jahresdaten · Transaktionen</em></article>
        </div>
        {(pdfImportMessage || dataMessage) && <div className={`data-feedback ${pdfImportState === "error" || dataMessage.startsWith("Import nicht") ? "error" : ""}`} role="status">{pdfImportState === "reading" && <span className="spinner" />}{pdfImportMessage || dataMessage}</div>}
        {transactions.length > 0 && <details className="transaction-summary"><summary><span><b>{transactions.length} importierte Transaktionen</b><small>Bestand aus Käufen, Verkäufen und Depotüberträgen; Ertrags- und Steuerereignisse bleiben im Journal</small></span><em>{transactionBalances.length} ISIN</em></summary><div className="balance-list">{transactionBalances.map((balance) => <article key={balance.isin}><span><b>{balance.isin}</b><small>{balance.transactions} bestandswirksame Belege</small></span><strong className={balance.units < 0 ? "negative" : ""}>{balance.units.toLocaleString("de-AT", { maximumFractionDigits: 8 })} Stk.</strong><button type="button" onClick={() => { setIdentifier(balance.isin); document.querySelector("#rechner")?.scrollIntoView({ behavior: "smooth" }); }}>Verwenden →</button></article>)}</div><div className="transaction-ledger"><div className="ledger-label">Erkannte Belege bitte kontrollieren</div>{transactions.map((item) => <article key={item.id}><span className={`trade-type ${item.type}`}>{brokerTransactionTypeLabels[item.type]}</span><span><b>{formatShortDate(item.date)} · {item.isin ?? "Kontobeleg"}</b><small>{item.broker ?? "Broker offen"} · {item.sourceFile}</small></span><strong>{formatBrokerTransactionValue(item)}</strong><em className={`confidence ${item.confidence}`}>{item.confidence === "high" ? "hoch" : item.confidence === "medium" ? "mittel" : "prüfen"}</em><button type="button" aria-label={`${item.sourceFile} entfernen`} onClick={() => setTransactions((current) => current.filter((transaction) => transaction.id !== item.id))}>×</button></article>)}</div><button className="clear-transactions" type="button" onClick={() => { if (window.confirm("Alle importierten Transaktionen entfernen? Gespeicherte ETF-Jahreswerte bleiben erhalten.")) setTransactions([]); }}>Alle Transaktionen entfernen</button></details>}
      </section>

      <div className="dashboard-layout">
        <section className="holdings-panel" aria-label="Aktuelle ETF-Holdings">
          <div className="panel-heading"><div><span className="mini-kicker">Automatisch aus deinem lokalen Portfolio</span><h2>Aktuelle Holdings</h2><p>Je ETF wird der neueste gespeicherte Stand gezeigt. Frühere Steuerjahre bleiben darunter im Verlauf erhalten.</p></div><button type="button" onClick={startNewPosition}>+ Neu</button></div>
          {currentHoldings.length === 0 ? <div className="holdings-empty"><span className="empty-symbol">◎</span><div><h3>Noch kein ETF gespeichert</h3><p>Starte mit einer ISIN. Das Tool lädt die offizielle OeKB-Meldung und fragt anschließend nur nach deiner Stückzahl am Meldetag.</p><ol><li><b>1</b> ISIN eingeben</li><li><b>2</b> Stückzahl prüfen</li><li><b>3</b> Ergebnis speichern</li></ol><button type="button" onClick={startNewPosition}>Ersten ETF hinzufügen →</button></div></div> : <div className="holdings-list">{currentHoldings.map((entry) => {
            const pending = entry.reportTracking?.state === "pending";
            const prediction = entry.oekbResult?.prediction ?? entry.reportTracking?.prediction;
            return <article className="holding-row" key={entry.id}><span className="fund-avatar">ETF</span><div className="holding-name"><strong>{entry.security?.name ?? entry.oekbResult?.fundName ?? entry.identifier}</strong><small>{entry.identifier} · letzter Stand {entry.taxYear}</small></div><div className="holding-cell"><small>Stück am Meldetag <Info>Maßgeblich ist der Bestand am veröffentlichten OeKB-Meldetag, nicht zwingend dein heutiger Bestand.</Info></small><b>{pending && entry.values.units === 0 ? "noch offen" : entry.values.units.toLocaleString("de-AT")}</b></div><div className="holding-cell"><small>Meldestatus</small><span className={`plain-status ${pending ? "pending" : "ready"}`}>{pending ? "◷ ausständig" : "✓ übernommen"}</span>{prediction && <em>erwartet ca. {formatShortDate(prediction.expectedDate)}</em>}</div><div className="holding-cell tax-cell"><small>Steuerschätzung</small><b>{pending ? "—" : eur.format(entry.result.estimatedTax)}</b></div><div className="holding-actions">{pending && <button type="button" onClick={() => retryPendingPosition(entry)} disabled={retryingPositionId === entry.id}>{retryingPositionId === entry.id ? "Prüfe …" : "Meldung prüfen"}</button>}<button type="button" onClick={() => editPosition(entry)}>Öffnen →</button></div></article>;
          })}</div>}
          {portfolio.length > 0 && <details className="history-drawer"><summary>Alle gespeicherten Steuerjahre anzeigen <span>{portfolio.length} Einträge</span></summary><div className="history-list">{portfolio.map((entry) => <article key={entry.id}><div><b>{entry.security?.name ?? entry.oekbResult?.fundName ?? entry.identifier}</b><small>{entry.identifier} · {entry.taxYear} · {entry.ownershipStatus === "held" ? "im Bestand" : "verkauft"}</small></div><span>{entry.reportTracking?.state === "pending" ? "Meldung offen" : eur.format(entry.result.estimatedTax)}</span><button type="button" onClick={() => editPosition(entry)}>Öffnen</button><button className="danger-link" type="button" onClick={() => removePosition(entry)}>Entfernen</button></article>)}</div></details>}
        </section>

        <aside className={`next-task ${currentYearPending.length ? "attention" : ""}`}><span className="next-task-label">Dein nächster Schritt</span>{currentYearPortfolio.length === 0 ? <><div className="next-task-icon">1</div><h2>Ersten ETF erfassen</h2><p>Halte deine ISIN bereit. OeKB-Werte und EUR-Kurs lädt das Tool automatisch.</p><button type="button" onClick={startNewPosition}>Jetzt beginnen →</button></> : currentYearPending.length ? <><div className="next-task-icon">!</div><h2>{currentYearPending.length} Meldung{currentYearPending.length === 1 ? " ist" : "en sind"} noch offen</h2><p>Das ist normal, wenn die OeKB-Jahresmeldung noch nicht veröffentlicht wurde. Deine Position bleibt gespeichert.</p><button type="button" onClick={() => retryPendingPosition(currentYearPending[0])}>Erste Meldung prüfen →</button></> : <><div className="next-task-icon">✓</div><h2>Aktuell alles erledigt</h2><p>Für deine gespeicherten Positionen sind die Jahreswerte vorhanden. Prüfe vor der Abgabe noch die FinanzOnline-Summen.</p><a href="#finanzonline">Jahressummen ansehen →</a></>}</aside>
      </div>
    </section>

    <section className="workspace" id="rechner">
      <div className="workspace-heading"><div><p className="eyebrow">Geführte Berechnung</p><h2>{activePositionId ? "ETF-Eintrag bearbeiten" : "ETF für ein Steuerjahr berechnen"}</h2><p>Das Tool führt dich in drei Schritten durch die Berechnung. Automatisch geladene Fachwerte sind klar markiert; du ergänzt nur deine persönlichen Depotdaten.</p></div>{activePositionId && <button type="button" onClick={startNewPosition}>+ Neuen ETF beginnen</button>}</div>
      <div className="stepper" aria-label="Fortschritt"><div className="active"><b>1</b><span>ETF wählen<small>ISIN & Steuerjahr</small></span></div><i /><div className={oekbState === "done" || importState === "done" ? "active" : ""}><b>2</b><span>Bestand ergänzen<small>Stückzahl am Meldetag</small></span></div><i /><div className={showResults ? "active" : ""}><b>3</b><span>Ergebnis sichern<small>Steuer & FinanzOnline</small></span></div></div>
      <div className="calculator-grid">
        <section className="card form-card">
          <div className="card-heading"><div><span className="section-number">01</span><h2>Welchen ETF hältst du?</h2></div><span className="source-badge">Wertpapier-Abgleich</span></div>
          <form className="lookup" onSubmit={lookup}>
            <label><span>ISIN oder WKN</span><div className="search-input"><span>⌕</span><input value={identifier} onChange={(e) => { setIdentifier(e.target.value.toUpperCase()); setOekbState("idle"); setLookupState("idle"); }} placeholder="z. B. IE00B4L5Y983" aria-label="ISIN oder WKN" />{identifier && <button type="button" onClick={() => { setIdentifier(""); setOekbState("idle"); setLookupState("idle"); }} aria-label="Eingabe leeren">×</button>}</div></label>
            <label className="year-select"><span>Steuerjahr</span><select value={taxYear} onChange={(e) => { setTaxYear(e.target.value); setOekbState("idle"); }}><option>2026</option><option>2025</option><option>2024</option><option>2023</option></select></label>
            <button className="primary" disabled={lookupState === "loading"}>{lookupState === "loading" ? "Lade …" : "ETF & OeKB laden"}<span>→</span></button>
          </form>
          {lookupState === "error" && <p className="error">Die Kennung ist ungültig oder konnte gerade nicht geprüft werden.</p>}
          {lookupState === "done" && <div className="security-result"><div className="fund-avatar">ETF</div><div><strong>{security?.name ?? "Wertpapier erkannt"}</strong><span>{security?.identifierType} {identifier}{security?.ticker ? ` · ${security.ticker}` : ""}</span></div><span className={security?.verified ? "verified" : "unverified"}>{security?.verified ? "✓ erkannt" : "manuell prüfen"}</span></div>}

          <div className="divider" />
          <div className="card-heading compact"><div><span className="section-number">02</span><h2>OeKB-Steuerdaten</h2></div><a className="external" href={oekbUrl} target="_blank" rel="noreferrer">Offizielle Meldung öffnen ↗</a></div>
          <p className="helper">Die Jahresmeldung und die vier Steuerwerte werden direkt aus dem öffentlichen OeKB-CSV-Export übernommen. Beträge bleiben in Fondswährung; der EUR-Kurs wird automatisch ergänzt.</p>
          <section className="oekb-auto" aria-label="OeKB-Daten per ISIN automatisch laden">
            <div className="smart-import-title"><div><span className="spark">Ö</span><div><strong>Direkt per ISIN laden</strong><small>OeKB-Melde-ID · Jahresmeldung · ECB-Referenzkurs</small></div></div><span className="auto-badge">KOSTENLOS</span></div>
            {oekbState !== "done" && <button className="oekb-button" type="button" onClick={() => loadOekbData()} disabled={oekbState === "loading" || !identifier.trim()}>{oekbState === "loading" ? "OeKB-Daten werden geladen …" : oekbState === "error" || oekbState === "missing" ? "OeKB erneut prüfen" : "OeKB-Steuerdaten automatisch laden"}<span>→</span></button>}
            <p className="privacy-copy">Kein Login und kein API-Key. Abfrage erfolgt erst nach deinem Klick und nur für die eingegebene ISIN.</p>
            {oekbState === "error" && <div className="import-message error-message"><b>Automatischer OeKB-Abruf nicht abgeschlossen</b><span>{oekbError}</span></div>}
            {oekbState === "missing" && pendingOekbInfo && <div className="import-message pending-message"><b>◷ Für {taxYear} noch keine Jahresmeldung</b><span>Der ETF wurde automatisch im Meldungs-Tracker gespeichert. Du kannst die Seite schließen und später bei der Position auf „Jetzt erneut prüfen“ klicken.</span>{pendingOekbInfo.prediction && <small>Voraussichtlich {formatShortDate(pendingOekbInfo.prediction.expectedDate)} · Fenster {formatShortDate(pendingOekbInfo.prediction.windowStart)}–{formatShortDate(pendingOekbInfo.prediction.windowEnd)}</small>}</div>}
            {oekbState === "done" && oekbResult && <div className="import-message success-message"><div><b>✓ Offizielle Jahresmeldung übernommen</b><span>{oekbResult.source}{oekbResult.exchangeRateSource ? ` · Kurs: ${oekbResult.exchangeRateSource} vom ${oekbResult.exchangeRateDate}` : ""}</span></div><div className="import-chips"><span>Melde-ID {oekbResult.reportId}</span><span>{oekbResult.currency ?? "Währung offen"}</span><span>{oekbResult.reportDate ?? "Meldedatum offen"}</span><span>{[oekbResult.actualDistributionPerUnit, oekbResult.deemedIncomePerUnit, oekbResult.creditableForeignTaxPerUnit, oekbResult.costBasisAdjustmentPerUnit].filter((value) => value !== null).length}/4 Steuerwerte</span></div>{oekbResult.prediction ? <div className="prediction-box"><span>Voraussichtliche nächste Jahresmeldung</span><strong>ca. {formatReportDate(oekbResult.prediction.expectedDate)}</strong><small>Zeitfenster {formatShortDate(oekbResult.prediction.windowStart)}–{formatShortDate(oekbResult.prediction.windowEnd)} · {confidenceLabel[oekbResult.prediction.confidence]} · aus {oekbResult.prediction.sampleSize} Meldedaten</small><em>Prognose aus historischen Abständen, keine OeKB-Terminankündigung.</em></div> : <div className="prediction-box unavailable"><span>Nächste Jahresmeldung</span><strong>Noch nicht verlässlich prognostizierbar</strong><small>Mindestens zwei plausible historische Jahresmeldungen sind erforderlich.</small></div>}{oekbResult.warnings.length > 0 && <details><summary>{oekbResult.warnings.length} Prüfhinweis{oekbResult.warnings.length === 1 ? "" : "e"}</summary><ul>{oekbResult.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></details>}</div>}
          </section>
          <details className="fallback-import">
            <summary><span>Notfall-Import per Copy-Paste / Gemini</span><small>Nur falls der öffentliche OeKB-Export vorübergehend nicht erreichbar ist</small></summary>
            <section className="smart-import" aria-label="OeKB-Seite als Notfall importieren">
            <div className="smart-import-title"><div><span className="spark">✦</span><div><strong>Ganze OeKB-Seite auslesen</strong><small>Lokal vorgeprüft · optional präziser mit deinem Gemini-Key</small></div></div><span className="byok-badge">BYOK</span></div>
            <label className="paste-field"><span>Kopierten Seiteninhalt einfügen</span><textarea value={pastedOekb} onChange={(event) => { setPastedOekb(event.target.value); setImportState("idle"); }} placeholder="OeKB-Seite öffnen, alles markieren (Strg/Cmd + A), kopieren und hier einfügen …" /></label>
            <div className="key-row">
              <label><span>Gemini API-Key <em>optional</em></span><div className="key-input"><input type={showGeminiKey ? "text" : "password"} value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} placeholder="AIza…" autoComplete="off" /><button type="button" onClick={() => setShowGeminiKey((value) => !value)}>{showGeminiKey ? "verbergen" : "anzeigen"}</button></div></label>
              <button className="extract-button" type="button" onClick={importOekbData} disabled={importState === "extracting"}>{importState === "extracting" ? "Werte werden erkannt …" : "Werte automatisch übernehmen"}<span>→</span></button>
            </div>
            <div className="key-options"><label><input type="checkbox" checked={saveGeminiKey} onChange={(event) => setSaveGeminiKey(event.target.checked)} /> Key nur in diesem Browser speichern</label><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Kostenlosen Key erstellen ↗</a></div>
            <p className="privacy-copy">Dein Key wird direkt von diesem Browser an Google gesendet, nie an unseren Server. Ohne Key läuft nur die lokale Erkennung.</p>
            {importState === "error" && <div className="import-message error-message"><b>Import nicht abgeschlossen</b><span>{importError}</span></div>}
            {importState === "done" && importResult && <div className="import-message success-message"><div><b>✓ Werte übernommen</b><span>{importResult.model ? `Gemini ${importResult.model.replace("gemini-", "")} + lokale Prüfung` : "Lokale Erkennung"}{importResult.exchangeRateSource ? ` · Kurs: ${importResult.exchangeRateSource} vom ${importResult.exchangeRateDate}` : ""}</span></div><div className="import-chips"><span>{importResult.currency ?? "Währung offen"}</span><span>{importResult.reportDate ?? "Meldedatum offen"}</span><span>{[importResult.actualDistributionPerUnit, importResult.deemedIncomePerUnit, importResult.creditableForeignTaxPerUnit, importResult.costBasisAdjustmentPerUnit].filter((value) => value !== null).length}/4 Steuerwerte</span></div>{importResult.warnings.length > 0 && <details><summary>{importResult.warnings.length} Prüfhinweis{importResult.warnings.length === 1 ? "" : "e"}</summary><ul>{importResult.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></details>}</div>}
            </section>
          </details>
          <div className="segmented" role="group" aria-label="Fondsstatus"><button className={status === "reporting" ? "selected" : ""} onClick={() => setStatus("reporting")} type="button"><b>Meldefonds</b><small>OeKB-Jahresmeldung vorhanden</small></button><button className={status === "non-reporting" ? "selected warning" : ""} onClick={() => setStatus("non-reporting")} type="button"><b>Nicht-Meldefonds</b><small>Pauschalbesteuerung</small></button></div>
          <div className="ownership-toggle" role="group" aria-label="Status der ETF-Position"><span>Diese Position</span><button className={ownershipStatus === "held" ? "selected" : ""} type="button" onClick={() => setOwnershipStatus("held")}>✓ Halte ich noch</button><button className={ownershipStatus === "sold" ? "selected sold" : ""} type="button" onClick={() => { setOwnershipStatus("sold"); setShowSale(true); }}>Bereits verkauft</button></div>
          <section className={`holding-entry ${unitsComplete ? "complete" : ""}`} aria-label="Erforderliche Stückzahl">
            <div className="holding-entry-head"><div><span className="action-kicker">Deine einzige Pflichtangabe</span><h3>{status === "reporting" ? "Wie viele Anteile hattest du am Meldetag?" : "Wie viele Anteile sind zu berücksichtigen?"}</h3></div><span className="manual-badge">{unitsComplete ? "✓ EINGETRAGEN" : "JETZT EINGEBEN"}</span></div>
            {status === "reporting" && <div className={`holding-date ${formattedReportDate ? "known" : ""}`}><span>OeKB-Meldetag / steuerlicher Stichtag</span><strong>{formattedReportDate ?? "Wird nach dem OeKB-Import angezeigt"}</strong>{activeImport?.reportDate && <small>{activeImport.reportDate} · Bestand im Depotauszug an diesem Tag prüfen</small>}</div>}
            {brokerUnitsAtReport && brokerUnitsAtReport.matchedTransactions > 0 && <div className={`broker-units ${brokerUnitsAtReport.units > 0 ? "found" : "warning"}`}><div><span>Aus PDF-Transaktionen zum Stichtag</span><strong>{brokerUnitsAtReport.units.toLocaleString("de-AT", { maximumFractionDigits: 8 })} Stück</strong><small>{brokerUnitsAtReport.matchedTransactions} bestandswirksame Transaktion{brokerUnitsAtReport.matchedTransactions === 1 ? "" : "en"} bis {activeImport?.reportDate}</small></div>{brokerUnitsAtReport.units > 0 && (values.units !== brokerUnitsAtReport.units ? <button type="button" onClick={() => setField("units", brokerUnitsAtReport.units)}>Stückzahl übernehmen</button> : <span className="imported-pill">✓ automatisch übernommen</span>)}</div>}
            <Field className="units-field" label="Deine Stückzahl an genau diesem Tag" value={values.units} onChange={(v) => setField("units", v)} suffix="Stk." step="0.000001" hint="Nicht die heutige Stückzahl, sondern dein Bestand am veröffentlichten Meldetag." />
            <p className="holding-help">{status === "reporting" ? "Nicht den heutigen Bestand eintragen: Maßgeblich ist deine Stückzahl am oben genannten Meldetag." : "Trage die für das gewählte Steuerjahr maßgebliche Stückzahl ein."}</p>
          </section>
          <details className="imported-values-details" open={status === "non-reporting"}><summary><div><span>{status === "reporting" ? "Automatisch übernommene OeKB-Werte" : "Weitere Berechnungswerte"}</span><small>{status === "reporting" ? "Nur öffnen, wenn du die importierten Fachwerte kontrollieren möchtest." : "Für Nicht-Meldefonds sind diese Werte erforderlich."}</small></div>{status === "reporting" && activeImport ? <b>✓ vollständig importiert</b> : <em>anzeigen</em>}</summary><div className="field-grid imported-field-grid">
            <Field label="EUR-Umrechnungskurs" value={values.eurRate} onChange={(v) => setField("eurRate", v)} suffix="EUR / FW" hint="Bei OeKB-Werten in EUR auf 1 lassen; sonst EUR-Wert einer Einheit Fondswährung am Meldetag." imported={status === "reporting" && importedValue(activeImport?.eurRate)} importLabel={activeImport?.exchangeRateSource ? "ECB ergänzt" : "importiert"} />
            {status === "reporting" ? <><Field label="Tatsächliche Ausschüttung je Anteil" value={values.distributionsPerUnit} onChange={(v) => setField("distributionsPerUnit", v)} suffix={perUnitCurrency} hint="Steuerpflichtige tatsächliche Ausschüttungen laut Meldung bzw. Ausschüttungsnachweis." imported={importedValue(activeImport?.actualDistributionPerUnit)} /><Field label="Ausschüttungsgleiche Erträge je Anteil" value={values.deemedIncomePerUnit} onChange={(v) => setField("deemedIncomePerUnit", v)} suffix={perUnitCurrency} hint="OeKB-Wert der ausschüttungsgleichen Erträge für Privatanleger." imported={importedValue(activeImport?.deemedIncomePerUnit)} /><Field label="Anrechenbare Quellensteuer je Anteil" value={values.creditableTaxPerUnit} onChange={(v) => setField("creditableTaxPerUnit", v)} suffix={perUnitCurrency} hint="Nur laut OeKB anrechenbarer Betrag, nicht automatisch jede ausländische Steuer." imported={importedValue(activeImport?.creditableForeignTaxPerUnit)} /><Field label="Korrektur Anschaffungskosten je Anteil" value={values.costAdjustmentPerUnit} onChange={(v) => setField("costAdjustmentPerUnit", v)} suffix={perUnitCurrency} hint="Für den späteren Verkaufsgewinn fortschreiben; kann laut Meldung auch negativ sein." allowNegative imported={importedValue(activeImport?.costBasisAdjustmentPerUnit)} /></> : <><Field label="Rücknahmepreis Jahresanfang" value={values.openingPricePerUnit} onChange={(v) => setField("openingPricePerUnit", v)} hint="Preis zu Beginn des Kalenderjahres; bei unterjährigem Kauf grundsätzlich der Anschaffungspreis." /><Field label="Rücknahmepreis Jahresende" value={values.closingPricePerUnit} onChange={(v) => setField("closingPricePerUnit", v)} hint="Letzter im Kalenderjahr festgesetzter Rücknahmepreis." /><Field label="Tatsächliche Ausschüttung je Anteil" value={values.distributionsPerUnit} onChange={(v) => setField("distributionsPerUnit", v)} /></>}
          </div></details>
          <section className="cost-basis-ledger" aria-label="Anschaffungskosten-Verlauf">
            <div className="ledger-heading"><div><span className="mini-kicker">Jahresübergreifend je ISIN</span><h3>Anschaffungskosten-Verlauf</h3><p>Das Tool addiert die gespeicherten OeKB-Korrekturen zur ursprünglichen Kostenbasis. Positive Korrekturen erhöhen, negative vermindern die steuerlichen Anschaffungskosten.</p></div><span className="ledger-total">{eur.format(costBasisLedger.correctedCostBasis)}</span></div>
            <Field className="base-cost-field" label="Ursprüngliche steuerliche Anschaffungskosten dieser Anteile" value={values.baseAcquisitionCost} onChange={(v) => setField("baseAcquisitionCost", v)} hint="Für Privatvermögen grundsätzlich der reine Kaufpreis der betreffenden Anteile; Anschaffungsnebenkosten sind regelmäßig nicht anzusetzen." />
            {correctionHistory.length > 0 ? <div className="ledger-list">{correctionHistory.map((correction) => {
              const included = costBasisLedger.eligibleCorrections.includes(correction);
              return <div className={!included ? "excluded" : ""} key={correction.id}><span><b>Steuerjahr {correction.taxYear}</b><small>{formatShortDate(correction.reportDate) ?? "Meldetag fehlt"}{correction.source === "current" ? " · aktuelle Berechnung" : " · gespeichert"}</small></span><strong className={correction.amount < 0 ? "negative" : ""}>{correction.amount >= 0 ? "+" : ""}{eur.format(correction.amount)}</strong>{!included && <em>nach Verkauf</em>}</div>;
            })}</div> : <p className="ledger-empty">Noch keine Jahreskorrektur gespeichert. Nach der ersten Berechnung erscheint sie hier automatisch.</p>}
            <div className="ledger-summary"><span><small>Ursprüngliche Kosten</small><b>{eur.format(values.baseAcquisitionCost)}</b></span><span><small>{saleDate ? "Korrekturen bis Verkauf" : "Korrekturen gesamt"}</small><b className={costBasisLedger.totalCorrection < 0 ? "negative" : ""}>{costBasisLedger.totalCorrection >= 0 ? "+" : ""}{eur.format(costBasisLedger.totalCorrection)}</b></span><span><small>Fortgeschriebene AK</small><b>{eur.format(costBasisLedger.correctedCostBasis)}</b></span></div>
            <button className="use-cost-basis" type="button" onClick={() => { setField("saleCostBasis", costBasisLedger.correctedCostBasis); setShowSale(true); }}>Als Verkaufs-Anschaffungskosten übernehmen →</button>
            <p className="ledger-warning">Bei Teilverkäufen nur die ursprünglichen Kosten und Korrekturen der tatsächlich verkauften Anteile übernehmen. Die Auswahl von Anschaffungslosen kann das Tool nicht aus deinem Depot ableiten.</p>
          </section>
          <button className="sale-toggle" type="button" onClick={() => setShowSale((value) => !value)}><span>{showSale ? "−" : "+"}</span>{ownershipStatus === "sold" ? "Verkaufsdaten dieser Position" : "ETF im Steuerjahr ganz oder teilweise verkauft?"}</button>
          {showSale && <section className="sale-fields" aria-label="Verkaufsdaten"><div className="sale-meta"><label><span>Währung des Verkaufserlöses</span><select value={saleCurrency} onChange={(event) => { const currency = event.target.value as SaleCurrency; setSaleCurrency(currency); setSaleFxState(currency === "EUR" ? "done" : "idle"); setSaleFxInfo(null); if (currency === "EUR") setField("saleFxRate", 1); }}><option value="EUR">EUR</option><option value="USD">USD</option></select></label><label><span>Verkaufsdatum</span><input type="date" value={saleDate} onChange={(event) => { const date = event.target.value; setSaleDate(date); setSaleFxState("idle"); setSaleFxInfo(null); if (saleCurrency === "USD" && date) void loadSaleFxRate(date); }} /></label></div><div className="field-grid"><Field label="Verkaufserlös gesamt" value={values.saleProceeds} onChange={(v) => setField("saleProceeds", v)} suffix={saleCurrency} /><Field label="Fortgeschriebene Anschaffungskosten" value={values.saleCostBasis} onChange={(v) => setField("saleCostBasis", v)} suffix="EUR" hint="Reiner Kaufpreis zuzüglich aller bisherigen OeKB-AK-Korrekturen bis zum Verkauf." /><Field label="Verkaufsspesen (nur Nachweis)" value={values.saleFees} onChange={(v) => setField("saleFees", v)} suffix={saleCurrency} hint="Bei privaten Kapitaleinkünften grundsätzlich nicht vom steuerpflichtigen Verkaufsgewinn abziehbar; wird daher nicht in KZ 994/892 eingerechnet." />{saleCurrency === "USD" && <Field label="EUR-Umrechnungskurs am Verkaufstag" value={values.saleFxRate} onChange={(v) => { setField("saleFxRate", v); setSaleFxState("done"); }} suffix="EUR / USD" step="0.000001" importLabel="ECB geladen" imported={saleFxState === "done"} />}</div>{saleCurrency === "USD" && <div className={`sale-fx-box ${saleFxState}`}><div><b>{saleFxState === "loading" ? "ECB-Kurs wird geladen …" : saleFxState === "done" ? `✓ ${eur.format(convertedSaleProceeds)} Erlös in EUR` : "USD automatisch in EUR umrechnen"}</b><span>{saleFxState === "done" ? `${eur.format(convertedSaleFees)} Spesen nur dokumentiert · ${saleFxInfo?.source ?? "Referenzkurs"}${saleFxInfo?.date ? ` vom ${saleFxInfo.date}` : ""}` : saleFxInfo?.error ?? "Verkaufsdatum wählen oder Kurs manuell eintragen."}</span></div><button type="button" onClick={() => loadSaleFxRate()} disabled={saleFxState === "loading" || !saleDate}>{saleFxState === "loading" ? "Lädt …" : "ECB-Kurs neu laden"}</button></div>}<p className="sale-note"><b>Steuerlogik:</b> Verkaufserlös minus fortgeschriebene Anschaffungskosten. Private Transaktionsspesen werden grundsätzlich nicht abgezogen. Der ECB-Referenzkurs bleibt eine Rechenhilfe; maßgebliche Umrechnungsmethode vor Abgabe prüfen.</p></section>}
          <button className="calculate" type="button" onClick={savePosition} disabled={!unitsComplete || !identifier.trim() || reportStillMissing}>{reportStillMissing ? "Meldung noch ausständig – später erneut prüfen" : unitsComplete ? (activePositionId ? "Berechnung im Portfolio aktualisieren" : "Berechnen & ETF im Portfolio speichern") : "Bitte zuerst Stückzahl eingeben"} <span>→</span></button><p className="local-note">🔒 Entwurf, Portfolio und Meldungs-Tracker werden nur in diesem Browser gespeichert.</p>
        </section>

        <aside className="results-column">
          <section className={`card result-card ${previewReady ? "revealed" : ""}`}><div className="result-live"><span>{showResults ? "✓ Im Portfolio gespeichert" : previewReady ? "● Live-Vorschau" : "Noch keine Berechnung"}</span></div><div className="result-top"><span>Voraussichtliche Steuer</span><strong>{previewReady ? eur.format(result.estimatedTax) : "—"}</strong><small>27,5 % der steuerpflichtigen Erträge minus anrechenbarer Quellensteuer</small></div><div className="result-metrics"><div><span>Steuerpflichtige Basis <Info>Summe der steuerpflichtigen Ausschüttungen, ausschüttungsgleichen Erträge und gegebenenfalls Verkaufsgewinne.</Info></span><b>{previewReady ? eur.format(result.taxableTotal) : "—"}</b></div><div><span>AK-Korrektur <Info>Verändert deine steuerlichen Anschaffungskosten für einen späteren Verkauf, wird aber nicht direkt in FinanzOnline eingetragen.</Info></span><b className={result.costAdjustment < 0 ? "negative" : ""}>{previewReady ? `${result.costAdjustment >= 0 ? "+" : ""}${eur.format(result.costAdjustment)}` : "—"}</b></div></div>{!previewReady && <div className="empty-state"><span>1—2—3</span><p>Zuerst ETF laden, dann die Stückzahl am angezeigten Meldetag eintragen. Die Vorschau erscheint sofort.</p></div>}</section>
          {previewReady && <section className="card filing-card" id="finanzonline"><div className="filing-title"><div><span className="mini-kicker">FinanzOnline · Beilage E1kv · {taxYear}</span><h3>{readyForYear.length > 1 ? "Diese Jahressummen übertragen" : "Diese Beträge werden benötigt"}</h3>{(readyForYear.length > 1 || pendingForYear.length > 0) && <small className="portfolio-filing-note">{readyForYear.length} berechnete Position{readyForYear.length === 1 ? "" : "en"}{pendingForYear.length ? ` · ${pendingForYear.length} noch nicht enthalten` : ""}</small>}</div><button onClick={() => window.print()} aria-label="Ergebnis drucken">↗</button></div><p className="filing-intro">Eine <b>Kennzahl (KZ)</b> ist ein nummeriertes Feld in FinanzOnline. Tippe auf eine Zeile, um den Betrag zu kopieren. Die Steuer selbst wird dort automatisch aus den eingetragenen Grundlagen berechnet.</p><div className="code-list">{[["898", "Tatsächliche Ausschüttungen", "Geld, das der Fonds wirklich ausgezahlt hat", filingResult.kz898], ["937", "Ausschüttungsgleiche Erträge", "Im Fonds verbliebene, aber bereits steuerpflichtige Erträge", filingResult.kz937], ["994", "Realisierte Wertsteigerungen", "Positiver Gewinn aus einem Verkauf", filingResult.kz994], ["892", "Realisierte Verluste", "Negatives Ergebnis aus einem Verkauf", filingResult.kz892], ["998", "Anrechenbare ausländische Steuer", "Von der OeKB ausgewiesene Steuergutschrift", filingResult.kz998]].map(([code, label, description, amount]) => <button className="code-row" key={String(code)} onClick={() => copyValue(String(code), Number(amount))}><span className="code">KZ {code}</span><span><b>{label}</b><small>{description}</small></span><strong>{eur.format(Number(amount))}</strong><em>{copied === code ? "kopiert" : "kopieren"}</em></button>)}</div><div className="filing-actions"><button onClick={downloadCsv}>{portfolioForYear.length > 1 ? "Portfolio-Nachweis laden" : "CSV-Nachweis laden"}</button><a href="https://finanzonline.bmf.gv.at/fon/" target="_blank" rel="noreferrer">FinanzOnline öffnen ↗</a></div></section>}
          <section className="card checklist"><span className="mini-kicker">Die drei häufigsten Fehler</span><h3>Darauf solltest du achten</h3><ul><li><span>1</span><p><b>Meldetag statt Fondsgeschäftsjahr</b>Für die Erklärung zählt das Kalenderjahr, in dem die OeKB-Meldung veröffentlicht wurde.</p></li><li><span>2</span><p><b>Bestand an genau diesem Tag</b>Käufe nach dem Meldetag gehören nicht mehr zu dieser konkreten Jahresmeldung.</p></li><li><span>3</span><p><b>AK-Korrekturen aufbewahren</b>Sie verhindern, dass bereits versteuerte Erträge beim Verkauf nochmals als Gewinn erfasst werden.</p></li></ul></section>
        </aside>
      </div>
    </section>

    <section className="knowledge" id="wissen"><div className="knowledge-intro"><p className="eyebrow">Begriffe einfach erklärt</p><h2>Kein Steuerdeutsch nötig.</h2><p>Öffne nur den Begriff, den du gerade brauchst. Dieselben Erklärungen findest du zusätzlich direkt an den Eingabefeldern über das kleine <b>i</b>.</p><button type="button" onClick={() => setShowTutorial(true)}>Ausführliches Praxisbeispiel öffnen →</button></div><div className="knowledge-grid glossary-cards"><details open><summary><span>01</span><b>Was ist ein Meldefonds?</b></summary><p>Ein Fonds, dessen steuerlicher Vertreter die österreichischen Steuerdaten an die OeKB meldet. Dadurch kann das Tool die tatsächlichen Werte verwenden. Bei einem Nicht-Meldefonds gilt meist eine pauschale, häufig ungünstigere Berechnung.</p></details><details><summary><span>02</span><b>Was bedeutet thesaurierend?</b></summary><p>Der Fonds zahlt Erträge nicht aus, sondern investiert sie wieder. Trotzdem können diese Erträge in Österreich bereits steuerpflichtig sein. Sie heißen dann <strong>ausschüttungsgleiche Erträge</strong>.</p></details><details><summary><span>03</span><b>Was ist der OeKB-Meldetag?</b></summary><p>Das Datum, an dem die Jahresmeldung veröffentlicht wurde. Für die Berechnung brauchst du die Anzahl deiner Anteile an genau diesem Tag – nicht zwingend deinen heutigen Bestand.</p></details><details><summary><span>04</span><b>Was ist anrechenbare Quellensteuer?</b></summary><p>Ausländische Steuer innerhalb der Fondserträge, die laut OeKB auf die österreichische Steuer angerechnet werden darf. Das Tool verwendet nur den offiziell als anrechenbar ausgewiesenen Betrag.</p></details><details><summary><span>05</span><b>Was bedeutet AK-Korrektur?</b></summary><p><strong>AK</strong> steht für Anschaffungskosten. Die Korrektur verändert deine steuerliche Kostenbasis. Sie ist kein eigenes FinanzOnline-Feld, wird aber für die korrekte Gewinnberechnung beim späteren Verkauf benötigt.</p></details><details><summary><span>06</span><b>Was sind KZ 898, 937 oder 998?</b></summary><p><strong>KZ</strong> bedeutet Kennzahl: ein nummeriertes Eingabefeld in der FinanzOnline-Beilage E1kv. Jede Kennzahl nimmt eine andere Art von Ertrag, Verlust oder anrechenbarer Steuer auf.</p></details></div></section>
    <section className="following-years" id="folgejahre"><div className="following-intro"><p className="eyebrow">Fortführung statt Neustart</p><h2>So gehst du in den Folgejahren vor</h2><p>Jede OeKB-Jahresmeldung ist ein weiterer Baustein deiner steuerlichen Kostenbasis. Das Portfolio speichert die Schritte lokal und führt sie je ISIN zusammen.</p></div><ol><li><span>1</span><div><b>Neue Jahresmeldung laden</b><p>Öffne die Position im jeweiligen Steuerjahr. Fehlt die Meldung noch, bleibt sie im Meldungs-Tracker vorgemerkt.</p></div></li><li><span>2</span><div><b>Stückzahl am Meldetag eintragen</b><p>Die Korrektur wird mit genau dem Bestand berechnet, den du am veröffentlichten Stichtag hattest.</p></div></li><li><span>3</span><div><b>Jahreskorrektur speichern</b><p>Positive Beträge erhöhen, negative vermindern die Anschaffungskosten. CSV und OeKB-Nachweis aufbewahren.</p></div></li><li><span>4</span><div><b>Beim Verkauf bis zum Verkaufsdatum fortschreiben</b><p>Ursprüngliche Kosten plus alle davor veröffentlichten Korrekturen bilden die Verkaufsbasis. Spätere Meldungen werden ausgeschlossen.</p></div></li><li><span>5</span><div><b>Teilverkäufe sauber zuordnen</b><p>Nur Kosten und Korrekturen der verkauften Anteile verwenden; verbleibende Anteile mit ihrer Restbasis weiterführen.</p></div></li></ol><aside><b>Wichtig</b><p>Die automatische Fortschreibung ersetzt keine Depot-Losrechnung oder individuelle Steuerberatung. Besonders bei mehreren Käufen, Teilverkäufen, Depotüberträgen und abweichenden Broker-Abrechnungen die Zuordnung prüfen.</p></aside></section>
    <footer><div className="brand footer-brand"><span className="brand-mark">AT</span><span><strong>ETF-Steuer</strong><small>Assistent Österreich</small></span></div><p>Rechenhilfe für österreichische Privatanleger · Keine Steuerberatung. Im Zweifel OeKB-Meldung, aktuelles E1kv-Formular und fachkundige Beratung heranziehen.</p><div><a href="https://www.oekb.at/kapitalmarkt-services/unser-datenangebot/fonds/steuerdaten.html" target="_blank" rel="noreferrer">OeKB Steuerdaten</a><a href="https://service.bmf.gv.at/service/anwend/formulare/show_mast.asp?Typ=SM&__ClFRM_STICHW_ALL=E1kv" target="_blank" rel="noreferrer">BMF E1kv</a></div></footer>
  </main></>;
}
