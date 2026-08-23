# ETF-Steuerassistent Österreich

Web-Rechenhilfe für österreichische Privatanleger mit Auslandsdepot. Die App
ermittelt anhand einer ISIN die passende OeKB-Jahresmeldung, übernimmt die
Steuerwerte je Anteil und berechnet daraus die relevanten E1kv-Kennzahlen.

## Funktionen

- direkter ISIN-Abruf über den öffentlichen OeKB-CSV-Export
- automatische Auswahl der gültigen Jahresmeldung im gewählten Steuerjahr
- Ausschüttungen, ausschüttungsgleiche Erträge, anrechenbare Quellensteuer und AK-Korrektur
- automatische EUR-Umrechnung über ECB-Referenzkurse
- mehrere gehaltene oder verkaufte ETFs und E1kv-Gesamtsummen je Steuerjahr
- Meldungs-Tracker und Prognose des nächsten OeKB-Meldetags
- Verkaufserlöse in EUR oder USD und jahresübergreifender Anschaffungskosten-Verlauf
- lokaler, Portfolio-Performance-artiger PDF-Import für Käufe, Verkäufe, Dividenden/Ausschüttungen, Steuern und Steuererstattungen, Gebühren sowie Depot-Ein-/Auslieferungen
- historischer Bestand am OeKB-Meldetag aus bestandswirksamen Käufen, Verkäufen und Depotüberträgen; reine Ertrags-/Steuerereignisse verändern den Bestand nicht
- getrennte Erfassung von Netto-/Bruttobetrag, Steuer, Gebühren und Devisenkurs soweit im Brokerbeleg vorhanden
- vollständiges JSON-Backup und strukturierter Excel-Export inklusive Broker-Ereignissen
- ausführliches Praxis-Tutorial und kontextbezogene Begriffserklärungen

PDFs, Portfolio und Rechnerdaten bleiben im Browser. Der optionale Gemini-BYOK-
Schlüssel wird nicht in Backups exportiert. Der PDF-Parser ist an das testbare
Extractor-Prinzip von Portfolio Performance angelehnt: Broker werden zuerst erkannt,
danach Dokumenttypen und begrenzte Belegblöcke. Unterstützt werden nur eindeutig
erkannte Pflichtfelder; erkannte Transaktionen müssen wegen möglicher Änderungen an
Broker-Layouts kontrolliert werden.

Für die ETF-Steuerberechnung werden bewusst nicht sämtliche Portfolio-Performance-
Kontobewegungen nachgebaut. Reine Ein-/Auszahlungen des Verrechnungskontos sind für
den historischen ETF-Bestand nicht erforderlich. Sinnvolle Wertpapier- und
Steuerereignisse werden dagegen im lokalen Transaktionsjournal und Excel-Nachweis
aufbewahrt.

Die Anwendung ist eine Rechenhilfe und keine Steuerberatung. OeKB-Meldung,
Depotauszug, Anschaffungslos-Zuordnung, Umrechnungskurs und aktuelles E1kv-Formular
müssen vor der Abgabe geprüft werden.

## Lokale Entwicklung

Voraussetzung: Node.js 22 oder neuer.

```bash
npm ci
npm run dev
```

Qualitätsprüfung:

```bash
npm run lint
npm test
```

## Deployment auf Vercel

Das Repository ist ein reguläres Next.js-Projekt und enthält die benötigten
Server-Routen unter `app/api/`. GitHub Pages ist deshalb nicht geeignet: Es kann
keine OeKB-, ECB- oder OpenFIGI-API-Routen ausführen.

1. In Vercel **Add New → Project** wählen.
2. Das GitHub-Repository `Persie0/etf-steuern-AT` importieren.
3. Framework Preset **Next.js** und Production Branch **main** verwenden.
4. **Deploy** wählen. Es werden keine Environment-Variablen benötigt.

Vercel baut mit `npm run build`. Jeder weitere Push auf `main` löst danach
automatisch ein Production-Deployment aus; Pull Requests erhalten Preview-URLs.

## Datenschutz und externe Dienste

- OeKB: öffentliche Fondssteuerdaten
- ECB: historische Referenzkurse
- OpenFIGI: optionaler Wertpapierabgleich
- Gemini: nur bei freiwilliger BYOK-Nutzung direkt aus dem Browser

Es gibt keinen Login und keine serverseitige Nutzerdatenbank.
