export type PdfTextItem = {
  str: string;
  hasEOL?: boolean;
  transform?: ArrayLike<number>;
  width?: number;
  height?: number;
};

function normalizePdfGlyphs(value: string): string {
  return value
    .replaceAll("ﬀ", "ff")
    .replaceAll("ﬁ", "fi")
    .replaceAll("ﬂ", "fl")
    .replaceAll("ﬃ", "ffi")
    .replaceAll("ﬄ", "ffl")
    .replace(/\u00ad/g, "")
    .replace(/\u00a0/g, " ");
}

export function layoutPdfTextItems(items: PdfTextItem[]): string {
  const positioned = items
    .map((item, index) => ({
      index,
      str: normalizePdfGlyphs(item.str),
      hasEOL: Boolean(item.hasEOL),
      x: Number(item.transform?.[4]),
      y: Number(item.transform?.[5]),
      width: Number(item.width ?? 0),
      height: Math.abs(Number(item.height ?? item.transform?.[3] ?? 0)),
    }))
    .filter((item) => item.str.length > 0);

  if (positioned.length === 0) return "";
  if (positioned.some((item) => !Number.isFinite(item.x) || !Number.isFinite(item.y))) {
    let fallback = "";
    for (const item of positioned.sort((a, b) => a.index - b.index)) {
      fallback += item.str;
      fallback += item.hasEOL ? "\n" : " ";
    }
    return fallback.replace(/[ \t]+\n/g, "\n").trim();
  }

  const rows: Array<{ y: number; tolerance: number; items: typeof positioned }> = [];
  for (const item of positioned) {
    const tolerance = Math.max(1.5, item.height * 0.35 || 2);
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(candidate.tolerance, tolerance));
    if (row) {
      const count = row.items.length;
      row.y = (row.y * count + item.y) / (count + 1);
      row.tolerance = Math.max(row.tolerance, tolerance);
      row.items.push(item);
    } else {
      rows.push({ y: item.y, tolerance, items: [item] });
    }
  }

  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x || a.index - b.index);
    let line = "";
    let previousRight: number | null = null;
    let previousCharWidth = 4;
    for (const item of row.items) {
      const ownCharWidth = item.width > 0 && item.str.length > 0 ? item.width / item.str.length : previousCharWidth;
      if (line && previousRight !== null) {
        const gap = item.x - previousRight;
        const unit = Math.max(2, (previousCharWidth + ownCharWidth) / 2);
        const spaces = gap > unit * 1.4 ? Math.min(12, Math.max(2, Math.round(gap / unit))) : 1;
        line += " ".repeat(spaces);
      }
      line += item.str;
      previousRight = item.x + Math.max(0, item.width);
      previousCharWidth = ownCharWidth;
    }
    return line.trimEnd();
  }).filter(Boolean).join("\n").trim();
}

export async function extractPdfText(file: File): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url), { type: "module" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => "str" in item ? [item as PdfTextItem] : []);
    pages.push(layoutPdfTextItems(items));
  }
  return { text: pages.join("\n\n--- Seite ---\n\n"), pages: document.numPages };
}
