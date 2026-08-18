"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { calculateEtfTax, FundStatus } from "../lib/tax";
import { OekbExtraction, parseOekbTextLocally } from "../lib/oekb-extractor";

type NumberField = "units" | "eurRate" | "distributionsPerUnit" | "deemedIncomePerUnit" | "creditableTaxPerUnit" | "costAdjustmentPerUnit" | "saleProceeds" | "saleCostBasis" | "saleFees" | "openingPricePerUnit" | "closingPricePerUnit";
type Values = Record<NumberField, number>;
type Security = { identifier: string; identifierType: "ISIN" | "WKN"; name: string | null; ticker: string | null; exchange: string | null; verified: boolean };

const initialValues: Values = { units: 10, eurRate: 1, distributionsPerUnit: 0, deemedIncomePerUnit: 0, creditableTaxPerUnit: 0, costAdjustmentPerUnit: 0, saleProceeds: 0, saleCostBasis: 0, saleFees: 0, openingPricePerUnit: 0, closingPricePerUnit: 0 };
const eur = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" });
const geminiModels = ["gemini-3-flash-preview", "gemini-3.7-flash", "gemini-2.5-flash-lite"];

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
  return <span className="info" title={String(children)}>i</span>;
}

function Field({ label, value, onChange, suffix = "EUR", hint, step = "0.0001", allowNegative = false }: { label: string; value: number; onChange: (value: number) => void; suffix?: string; hint?: string; step?: string; allowNegative?: boolean }) {
  return <label className="field">
    <span>{label} {hint && <Info>{hint}</Info>}</span>
    <div className="input-shell"><input inputMode="decimal" min={allowNegative ? undefined : "0"} step={step} type="number" value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} /><em>{suffix}</em></div>
  </label>;
}

export default function EtfTaxAssistant() {
  const [identifier, setIdentifier] = useState("IE00B4L5Y983");
  const [taxYear, setTaxYear] = useState("2025");
  const [status, setStatus] = useState<FundStatus>("reporting");
  const [values, setValues] = useState<Values>(initialValues);
  const [security, setSecurity] = useState<Security | null>(null);
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [showSale, setShowSale] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [pastedOekb, setPastedOekb] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [saveGeminiKey, setSaveGeminiKey] = useState(true);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [importState, setImportState] = useState<"idle" | "extracting" | "done" | "error">("idle");
  const [importResult, setImportResult] = useState<OekbExtraction | null>(null);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem("etf-steuerassistent-at");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { identifier?: string; taxYear?: string; status?: FundStatus; values?: Values };
          if (parsed.identifier) setIdentifier(parsed.identifier);
          if (parsed.taxYear) setTaxYear(parsed.taxYear);
          if (parsed.status) setStatus(parsed.status);
          if (parsed.values) setValues({ ...initialValues, ...parsed.values });
        } catch { /* Ignore broken local drafts. */ }
      }
      setGeminiKey(localStorage.getItem("etf-steuer-gemini-key") ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => { localStorage.setItem("etf-steuerassistent-at", JSON.stringify({ identifier, taxYear, status, values })); }, [identifier, taxYear, status, values]);
  useEffect(() => {
    if (saveGeminiKey && geminiKey) localStorage.setItem("etf-steuer-gemini-key", geminiKey);
    else if (!saveGeminiKey) localStorage.removeItem("etf-steuer-gemini-key");
  }, [geminiKey, saveGeminiKey]);

  const result = useMemo(() => calculateEtfTax({
    status,
    ...values,
    saleProceeds: showSale ? values.saleProceeds : 0,
    saleCostBasis: showSale ? values.saleCostBasis : 0,
    saleFees: showSale ? values.saleFees : 0,
  }), [status, values, showSale]);
  const oekbUrl = identifier.length === 12 ? `https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f?isin=${encodeURIComponent(identifier)}` : "https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f";
  const setField = (field: NumberField, value: number) => setValues((current) => ({ ...current, [field]: value }));

  async function lookup(event: FormEvent) {
    event.preventDefault();
    const normalized = identifier.trim().toUpperCase();
    setIdentifier(normalized); setLookupState("loading"); setShowResults(false);
    try {
      const response = await fetch("/api/security", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: normalized }) });
      const data = await response.json() as Security & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Lookup fehlgeschlagen");
      setSecurity(data); setLookupState("done");
    } catch { setSecurity(null); setLookupState("error"); }
  }

  function applyExtraction(extracted: OekbExtraction) {
    setValues((current) => ({
      ...current,
      eurRate: extracted.eurRate ?? current.eurRate,
      distributionsPerUnit: extracted.actualDistributionPerUnit ?? current.distributionsPerUnit,
      deemedIncomePerUnit: extracted.deemedIncomePerUnit ?? current.deemedIncomePerUnit,
      creditableTaxPerUnit: extracted.creditableForeignTaxPerUnit ?? current.creditableTaxPerUnit,
      costAdjustmentPerUnit: extracted.costBasisAdjustmentPerUnit ?? current.costAdjustmentPerUnit,
    }));
    if (extracted.isin) setIdentifier(extracted.isin.toUpperCase());
    if (extracted.reportDate) setTaxYear(extracted.reportDate.slice(0, 4));
    setStatus("reporting");
    setShowResults(false);
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

      if (extracted.eurRate === null && extracted.currency && extracted.reportDate) {
        const response = await fetch(`/api/fx?currency=${encodeURIComponent(extracted.currency)}&date=${encodeURIComponent(extracted.reportDate)}`);
        const fx = await response.json() as { rate?: number; date?: string; source?: string };
        if (response.ok && typeof fx.rate === "number") {
          extracted = { ...extracted, eurRate: fx.rate, exchangeRateDate: fx.date, exchangeRateSource: fx.source, warnings: [...extracted.warnings, "Kein OeKB-Kurs erkannt: Der ergänzte ECB-Referenzkurs ist vor Abgabe mit der steuerlich maßgeblichen Umrechnung zu prüfen."] };
        }
      }

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
    const rows = [["ETF-Steuerassistent Österreich", ""], ["Steuerjahr", taxYear], ["Kennung", identifier], ["ETF", security?.name ?? ""], ["E1kv KZ 898", result.kz898.toFixed(2)], ["E1kv KZ 937", result.kz937.toFixed(2)], ["E1kv KZ 994", result.kz994.toFixed(2)], ["E1kv KZ 892", result.kz892.toFixed(2)], ["E1kv KZ 998", result.kz998.toFixed(2)], ["Geschätzte Steuer", result.estimatedTax.toFixed(2)], ["AK-Korrektur", result.costAdjustment.toFixed(2)]];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `ETF-Steuer-${taxYear}-${identifier || "Auswertung"}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="ETF-Steuerassistent Startseite"><span className="brand-mark">AT</span><span><strong>ETF-Steuer</strong><small>Assistent Österreich</small></span></a>
      <nav aria-label="Hauptnavigation"><a href="#rechner">Rechner</a><a href="#finanzonline">FinanzOnline</a><a href="#wissen">Wissen</a></nav>
      <span className="privacy-pill"><span /> Lokal gespeichert</span>
    </header>

    <section className="hero" id="top">
      <div className="hero-copy"><p className="eyebrow"><span>🇦🇹</span> Für österreichische Privatanleger</p><h1>ETF-Steuern.<br /><em>Endlich nachvollziehbar.</em></h1><p className="lead">ISIN oder WKN eingeben, offizielle Fondsmeldung übernehmen und sofort sehen, wie viel Steuer anfällt — inklusive der richtigen E1kv-Kennzahlen für deinen Auslandsbroker.</p><div className="trust-row"><span>✓ Nur ETFs & Fonds</span><span>✓ 27,5 % Sondersteuersatz</span><span>✓ Keine Registrierung</span></div></div>
      <aside className="hero-note"><span className="note-icon">◎</span><div><strong>Warum nicht nur Stückzahl?</strong><p>Österreich besteuert auch thesaurierte Erträge. Entscheidend sind die OeKB-Meldung, der Meldetag und deine Stückzahl an genau diesem Tag.</p></div></aside>
    </section>

    <section className="workspace" id="rechner">
      <div className="stepper" aria-label="Fortschritt"><div className="active"><b>1</b><span>ETF finden<small>ISIN oder WKN</small></span></div><i /><div className={lookupState === "done" ? "active" : ""}><b>2</b><span>Steuerdaten<small>OeKB-Werte</small></span></div><i /><div className={showResults ? "active" : ""}><b>3</b><span>Ergebnis<small>E1kv & Steuer</small></span></div></div>
      <div className="calculator-grid">
        <section className="card form-card">
          <div className="card-heading"><div><span className="section-number">01</span><h2>Welchen ETF hältst du?</h2></div><span className="source-badge">Wertpapier-Abgleich</span></div>
          <form className="lookup" onSubmit={lookup}>
            <label><span>ISIN oder WKN</span><div className="search-input"><span>⌕</span><input value={identifier} onChange={(e) => setIdentifier(e.target.value.toUpperCase())} placeholder="z. B. IE00B4L5Y983" aria-label="ISIN oder WKN" />{identifier && <button type="button" onClick={() => setIdentifier("")} aria-label="Eingabe leeren">×</button>}</div></label>
            <label className="year-select"><span>Steuerjahr</span><select value={taxYear} onChange={(e) => setTaxYear(e.target.value)}><option>2025</option><option>2024</option><option>2023</option></select></label>
            <button className="primary" disabled={lookupState === "loading"}>{lookupState === "loading" ? "Prüfe …" : "ETF prüfen"}<span>→</span></button>
          </form>
          {lookupState === "error" && <p className="error">Die Kennung ist ungültig oder konnte gerade nicht geprüft werden.</p>}
          {lookupState === "done" && <div className="security-result"><div className="fund-avatar">ETF</div><div><strong>{security?.name ?? "Wertpapier erkannt"}</strong><span>{security?.identifierType} {identifier}{security?.ticker ? ` · ${security.ticker}` : ""}</span></div><span className={security?.verified ? "verified" : "unverified"}>{security?.verified ? "✓ erkannt" : "manuell prüfen"}</span></div>}

          <div className="divider" />
          <div className="card-heading compact"><div><span className="section-number">02</span><h2>OeKB-Steuerdaten</h2></div><a className="external" href={oekbUrl} target="_blank" rel="noreferrer">Offizielle Meldung öffnen ↗</a></div>
          <p className="helper">Übernimm die Werte der Jahresmeldung. Beträge dürfen in der Fondswährung bleiben — der EUR-Kurs rechnet sie gesammelt um.</p>
          <section className="smart-import" aria-label="OeKB-Daten automatisch übernehmen">
            <div className="smart-import-title"><div><span className="spark">✦</span><div><strong>Ganze OeKB-Seite automatisch auslesen</strong><small>Lokal vorgeprüft · optional präziser mit deinem Gemini-Key</small></div></div><span className="byok-badge">BYOK</span></div>
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
          <div className="segmented" role="group" aria-label="Fondsstatus"><button className={status === "reporting" ? "selected" : ""} onClick={() => setStatus("reporting")} type="button"><b>Meldefonds</b><small>OeKB-Jahresmeldung vorhanden</small></button><button className={status === "non-reporting" ? "selected warning" : ""} onClick={() => setStatus("non-reporting")} type="button"><b>Nicht-Meldefonds</b><small>Pauschalbesteuerung</small></button></div>
          <div className="field-grid">
            <Field label="Stückzahl am Meldetag" value={values.units} onChange={(v) => setField("units", v)} suffix="Stk." step="0.000001" hint="Nicht die heutige Stückzahl, sondern dein Bestand am veröffentlichten Meldetag." />
            <Field label="EUR-Umrechnungskurs" value={values.eurRate} onChange={(v) => setField("eurRate", v)} suffix="EUR / FW" hint="Bei OeKB-Werten in EUR auf 1 lassen; sonst EUR-Wert einer Einheit Fondswährung am Meldetag." />
            {status === "reporting" ? <><Field label="Tatsächliche Ausschüttung je Anteil" value={values.distributionsPerUnit} onChange={(v) => setField("distributionsPerUnit", v)} hint="Steuerpflichtige tatsächliche Ausschüttungen laut Meldung bzw. Ausschüttungsnachweis." /><Field label="Ausschüttungsgleiche Erträge je Anteil" value={values.deemedIncomePerUnit} onChange={(v) => setField("deemedIncomePerUnit", v)} hint="OeKB-Wert der ausschüttungsgleichen Erträge für Privatanleger." /><Field label="Anrechenbare Quellensteuer je Anteil" value={values.creditableTaxPerUnit} onChange={(v) => setField("creditableTaxPerUnit", v)} hint="Nur laut OeKB anrechenbarer Betrag, nicht automatisch jede ausländische Steuer." /><Field label="Korrektur Anschaffungskosten je Anteil" value={values.costAdjustmentPerUnit} onChange={(v) => setField("costAdjustmentPerUnit", v)} hint="Für den späteren Verkaufsgewinn fortschreiben; kann laut Meldung auch negativ sein." allowNegative /></> : <><Field label="Rücknahmepreis Jahresanfang" value={values.openingPricePerUnit} onChange={(v) => setField("openingPricePerUnit", v)} hint="Preis zu Beginn des Kalenderjahres; bei unterjährigem Kauf grundsätzlich der Anschaffungspreis." /><Field label="Rücknahmepreis Jahresende" value={values.closingPricePerUnit} onChange={(v) => setField("closingPricePerUnit", v)} hint="Letzter im Kalenderjahr festgesetzter Rücknahmepreis." /><Field label="Tatsächliche Ausschüttung je Anteil" value={values.distributionsPerUnit} onChange={(v) => setField("distributionsPerUnit", v)} /></>}
          </div>
          <button className="sale-toggle" type="button" onClick={() => setShowSale((value) => !value)}><span>{showSale ? "−" : "+"}</span> ETF im Steuerjahr verkauft?</button>
          {showSale && <div className="field-grid sale-fields"><Field label="Verkaufserlös gesamt" value={values.saleProceeds} onChange={(v) => setField("saleProceeds", v)} /><Field label="Fortgeschriebene Anschaffungskosten" value={values.saleCostBasis} onChange={(v) => setField("saleCostBasis", v)} hint="Kaufkosten zuzüglich aller bisherigen OeKB-AK-Korrekturen." /><Field label="Verkaufsspesen" value={values.saleFees} onChange={(v) => setField("saleFees", v)} /></div>}
          <button className="calculate" type="button" onClick={() => setShowResults(true)}>Steuer & Kennzahlen berechnen <span>→</span></button><p className="local-note">🔒 Entwurf wird nur in diesem Browser gespeichert.</p>
        </section>

        <aside className="results-column">
          <section className={`card result-card ${showResults ? "revealed" : ""}`}><div className="result-top"><span>Voraussichtliche Steuer</span><strong>{showResults ? eur.format(result.estimatedTax) : "—"}</strong><small>27,5 % abzüglich anrechenbarer Quellensteuer</small></div><div className="result-metrics"><div><span>Steuerpflichtige Basis</span><b>{showResults ? eur.format(result.taxableTotal) : "—"}</b></div><div><span>AK-Korrektur</span><b className={result.costAdjustment < 0 ? "negative" : ""}>{showResults ? `${result.costAdjustment >= 0 ? "+" : ""}${eur.format(result.costAdjustment)}` : "—"}</b></div></div>{!showResults && <div className="empty-state"><span>↳</span><p>Fülle links die Fondsdaten aus. Hier erscheinen Steuer und FinanzOnline-Felder.</p></div>}</section>
          {showResults && <section className="card filing-card" id="finanzonline"><div className="filing-title"><div><span className="mini-kicker">FinanzOnline · E1kv {taxYear}</span><h3>Diese Werte eintragen</h3></div><button onClick={() => window.print()} aria-label="Drucken">↗</button></div><div className="code-list">{[["898", "Tatsächliche Ausschüttungen", result.kz898], ["937", "Ausschüttungsgleiche Erträge", result.kz937], ["994", "Realisierte Wertsteigerungen", result.kz994], ["892", "Realisierte Verluste", result.kz892], ["998", "Anrechenbare ausländische Steuer", result.kz998]].map(([code, label, amount]) => <button className="code-row" key={String(code)} onClick={() => copyValue(String(code), Number(amount))}><span className="code">KZ {code}</span><span>{label}</span><strong>{eur.format(Number(amount))}</strong><em>{copied === code ? "kopiert" : "□"}</em></button>)}</div><div className="filing-actions"><button onClick={downloadCsv}>CSV-Nachweis laden</button><a href="https://finanzonline.bmf.gv.at/fon/" target="_blank" rel="noreferrer">FinanzOnline öffnen ↗</a></div></section>}
          <section className="card checklist"><h3>Damit das Ergebnis stimmt</h3><ul><li><span>1</span><p><b>Meldedatum statt Geschäftsjahr</b>Du versteuerst im Kalenderjahr der Veröffentlichung.</p></li><li><span>2</span><p><b>Stückzahl am Meldetag</b>Käufe danach zählen für diese Jahresmeldung nicht.</p></li><li><span>3</span><p><b>Anschaffungskosten fortschreiben</b>Sonst zahlst du beim Verkauf womöglich doppelt.</p></li></ul></section>
        </aside>
      </div>
    </section>

    <section className="knowledge" id="wissen"><div><p className="eyebrow">Kurz erklärt</p><h2>Was der Rechner für dich trennt</h2></div><div className="knowledge-grid"><article><span>01</span><h3>Ausschüttungen</h3><p>Tatsächlich ausbezahlte, steuerpflichtige Fondserträge landen bei einem Auslandsdepot in KZ 898.</p></article><article><span>02</span><h3>Thesaurierung</h3><p>Auch ein ETF ohne Auszahlung kann ausschüttungsgleiche Erträge erzeugen. Dafür ist KZ 937 vorgesehen.</p></article><article><span>03</span><h3>Verkauf</h3><p>Gewinn oder Verlust entsteht auf Basis der steuerlich fortgeschriebenen Anschaffungskosten.</p></article></div></section>
    <footer><div className="brand footer-brand"><span className="brand-mark">AT</span><span><strong>ETF-Steuer</strong><small>Assistent Österreich</small></span></div><p>Rechenhilfe für österreichische Privatanleger · Keine Steuerberatung. Im Zweifel OeKB-Meldung, aktuelles E1kv-Formular und fachkundige Beratung heranziehen.</p><div><a href="https://www.oekb.at/kapitalmarkt-services/unser-datenangebot/fonds/steuerdaten.html" target="_blank" rel="noreferrer">OeKB Steuerdaten</a><a href="https://service.bmf.gv.at/service/anwend/formulare/show_mast.asp?Typ=SM&__ClFRM_STICHW_ALL=E1kv" target="_blank" rel="noreferrer">BMF E1kv</a></div></footer>
  </main>;
}
