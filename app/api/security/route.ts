import { NextResponse } from "next/server";

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const WKN = /^[A-Z0-9]{6}$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { identifier?: string } | null;
  const identifier = body?.identifier?.trim().toUpperCase() ?? "";

  if (!ISIN.test(identifier) && !WKN.test(identifier)) {
    return NextResponse.json({ error: "Bitte eine gültige ISIN oder WKN eingeben." }, { status: 400 });
  }

  const idType = ISIN.test(identifier) ? "ID_ISIN" : "ID_WERTPAPIER";

  try {
    const response = await fetch("https://api.openfigi.com/v3/mapping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ idType, idValue: identifier }]),
    });

    if (!response.ok) throw new Error("lookup unavailable");
    const payload = (await response.json()) as Array<{
      data?: Array<{ name?: string; ticker?: string; securityType2?: string; exchCode?: string }>;
    }>;
    const candidates = payload[0]?.data ?? [];
    const fund = candidates.find((item) =>
      /fund|etf|mutual/i.test(`${item.securityType2 ?? ""} ${item.name ?? ""}`),
    ) ?? candidates[0];

    return NextResponse.json({
      identifier,
      identifierType: idType === "ID_ISIN" ? "ISIN" : "WKN",
      name: fund?.name ?? null,
      ticker: fund?.ticker ?? null,
      exchange: fund?.exchCode ?? null,
      verified: Boolean(fund),
    });
  } catch {
    return NextResponse.json({ identifier, identifierType: idType === "ID_ISIN" ? "ISIN" : "WKN", name: null, ticker: null, exchange: null, verified: false });
  }
}
