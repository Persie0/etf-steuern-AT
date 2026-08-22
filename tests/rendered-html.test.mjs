import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /OeKB-Steuerdaten automatisch laden/);
  assert.match(html, /Deine einzige Pflichtangabe/);
  assert.match(html, /OeKB-Meldetag \/ steuerlicher Stichtag/);
  assert.match(html, /Bitte zuerst Stückzahl eingeben/);
  assert.match(html, /Dein Steuer-Dashboard/);
  assert.match(html, /Aktuelle Holdings/);
  assert.match(html, /Deine Datenzentrale/);
  assert.match(html, /Broker-Abrechnungen importieren/);
  assert.match(html, /Vollständiges Backup/);
  assert.match(html, /Excel-Übersicht/);
  assert.match(html, /Bestand am OeKB-Meldetag/);
  assert.match(html, /Dein nächster Schritt/);
  assert.match(html, /Geführte Berechnung/);
  assert.match(html, /Automatisch übernommene OeKB-Werte/);
  assert.match(html, /Die Vorschau erscheint sofort/);
  assert.match(html, /Kein Steuerdeutsch nötig/);
  assert.match(html, /Bereits verkauft/);
  assert.match(html, /Anschaffungskosten-Verlauf/);
  assert.match(html, /Verkaufs-Anschaffungskosten übernehmen/);
  assert.match(html, /So gehst du in den Folgejahren vor/);
  assert.match(html, /Vanguard FTSE All-World UCITS ETF/);
  assert.match(html, /IE00BK5BQT80/);
  assert.match(html, /416424 · 488736 · 564233/);
  assert.match(html, /1,4369 × 10 × 0,917852 = 13,19 €/);
  assert.match(html, /Was kommt wohin/);
  assert.match(html, /KZ 937/);
  assert.match(html, /Anschaffungskosten-Korrektur/);
  assert.match(html, /Private Transaktionsspesen/);
  assert.match(html, /Begriffe ohne Steuerdeutsch/);
  assert.match(html, /Zum ETF-Rechner/);
});
