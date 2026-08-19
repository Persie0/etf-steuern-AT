export const runtime = "edge";

type EcbObservation = { date: string; foreignPerEur: number };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const currency = (url.searchParams.get("currency") ?? "").trim().toUpperCase();
  const date = (url.searchParams.get("date") ?? "").trim();

  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "Währung und Meldedatum fehlen." }, { status: 400 });
  }
  if (currency === "EUR") return Response.json({ rate: 1, date, source: "EUR" });

  try {
    const response = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml", {
      headers: { accept: "application/xml" },
    });
    if (!response.ok) throw new Error("ECB nicht erreichbar");
    const xml = await response.text();
    const days = [...xml.matchAll(/<Cube\s+time=['\"](\d{4}-\d{2}-\d{2})['\"]>([\s\S]*?)<\/Cube>/g)];
    const observations: EcbObservation[] = [];
    for (const day of days) {
      if (day[1] > date) continue;
      const currencyExpression = new RegExp(`<Cube\\s+currency=['\"]${currency}['\"]\\s+rate=['\"]([0-9.]+)['\"]\\s*\\/>`);
      const rate = day[2].match(currencyExpression)?.[1];
      if (rate) observations.push({ date: day[1], foreignPerEur: Number(rate) });
    }
    observations.sort((a, b) => b.date.localeCompare(a.date));
    const observation = observations[0];
    if (!observation?.foreignPerEur) return Response.json({ error: "Kein ECB-Kurs gefunden." }, { status: 404 });
    return Response.json({
      rate: 1 / observation.foreignPerEur,
      date: observation.date,
      source: "ECB reference rate",
      foreignPerEur: observation.foreignPerEur,
    });
  } catch {
    return Response.json({ error: "ECB-Kurs konnte nicht geladen werden." }, { status: 502 });
  }
}
