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
  assert.match(html, /Meine ETF-Positionen/);
  assert.match(html, /Weiteren ETF hinzufügen/);
  assert.match(html, /Bereits verkauft/);
  assert.match(html, /Meldungs-Tracker/);
  assert.match(html, /automatisch im Tracker gespeichert/);
  assert.match(html, /Anschaffungskosten-Verlauf/);
  assert.match(html, /Verkaufs-Anschaffungskosten übernehmen/);
  assert.match(html, /So gehst du in den Folgejahren vor/);
  assert.match(html, /Vom ETF-Kauf bis zum Verkauf/);
  assert.match(html, /Kauf, drei Jahre halten, dann verkaufen/);
  assert.match(html, /20 ETF-Anteile × 100 € = 2.000 €/);
  assert.match(html, /Zum ETF-Rechner/);
});
