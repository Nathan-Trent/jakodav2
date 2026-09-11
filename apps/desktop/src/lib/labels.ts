import JsBarcode from "jsbarcode";

/**
 * Label printing (TRD §7: "straightforward PDF/label output"). We render
 * barcodes as SVG with JsBarcode, lay them out on a print-only page, and
 * hand it to the OS print dialog — which also gives "Save as PDF" for free.
 *
 * Two layouts:
 *  - "sheet": A4 grid of 38×21 mm labels (65 per sheet, common laser sheets)
 *  - "roll":  one 50×30 mm label per page (thermal label printers)
 */
export type LabelLayout = "sheet" | "roll";

export interface LabelSpec {
  code: string;
  name: string;
  price?: string; // formatted, optional
  copies: number;
}

function barcodeSvg(code: string): string {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const isEan13 = /^\d{13}$/.test(code);
  JsBarcode(svg, code, {
    format: isEan13 ? "EAN13" : "CODE128",
    displayValue: true,
    fontSize: 11,
    textMargin: 1,
    height: 34,
    width: isEan13 ? 1.2 : 1.1,
    margin: 0,
    flat: true,
  });
  return svg.outerHTML;
}

export function buildLabelDocument(labels: LabelSpec[], layout: LabelLayout, shopName: string): string {
  const cells = labels.flatMap((l) => Array.from({ length: l.copies }, () => l));
  const css =
    layout === "sheet"
      ? `@page { size: A4; margin: 10.7mm 4.7mm; }
         .grid { display: grid; grid-template-columns: repeat(5, 38mm); grid-auto-rows: 21.2mm; column-gap: 2.5mm; }
         .cell { width: 38mm; height: 21.2mm; padding: 1mm 1.5mm; box-sizing: border-box; overflow: hidden; }
         svg { width: 100%; height: 11mm; }
         .name { font-size: 7pt; }`
      : `@page { size: 50mm 30mm; margin: 0; }
         .grid { display: block; }
         .cell { width: 50mm; height: 30mm; padding: 2mm 3mm; box-sizing: border-box; overflow: hidden; page-break-after: always; }
         svg { width: 100%; height: 14mm; }
         .name { font-size: 9pt; }`;
  const body = cells
    .map(
      (l) => `<div class="cell">
        <div class="name">${esc(l.name)}${l.price ? ` <b>${esc(l.price)}</b>` : ""}</div>
        ${barcodeSvg(l.code)}
      </div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels — ${esc(shopName)}</title>
    <style>
      html, body { margin: 0; padding: 0; font-family: Manrope, Inter, system-ui, sans-serif; color: #000; }
      .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 0.5mm; }
      ${css}
    </style></head><body><div class="grid">${body}</div>
    <script>window.onload = () => { window.print(); }</script></body></html>`;
}

/** Opens the print dialog in a hidden iframe (no new window in the webview). */
export function printLabels(labels: LabelSpec[], layout: LabelLayout, shopName: string): void {
  const html = buildLabelDocument(labels, layout, shopName);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  // Give the print dialog time to open before tearing the frame down.
  frame.contentWindow?.addEventListener("afterprint", () => frame.remove());
  window.setTimeout(() => frame.parentNode && frame.remove(), 60_000);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
