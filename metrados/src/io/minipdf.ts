/**
 * Escritor mínimo de PDF vectorial (sin dependencias): líneas, rectángulos, curvas, rellenos, texto con Helvetica
 * y capas (grupos de contenido opcional), como los PDF que exporta un programa de CAD.
 *
 * Sirve para dos cosas: generar el plano de ejemplo que trae la app y fabricar PDF de prueba con geometría conocida
 * para comprobar que lo que la app lee del archivo coincide con lo que se escribió.
 */

export interface MiniPdfPage {
  /** Tamaño de la página en puntos. */
  width: number;
  height: number;
  /** Operadores de contenido (ver PdfCanvas). */
  content: string;
  rotate?: 0 | 90 | 180 | 270;
  /** /UserUnit de la página (tamaño de la unidad en 1/72 de pulgada). */
  userUnit?: number;
}

export interface MiniPdfOptions {
  /** Nombres de las capas; en el contenido se usan con PdfCanvas.beginLayer(índice). */
  layers?: string[];
  /** Capas que nacen apagadas. */
  hiddenLayers?: number[];
  title?: string;
}

const num = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** Texto → cadena PDF en WinAnsi (Latin-1), con escapes octales para lo que no es ASCII imprimible. */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `${out})`;
}

/** Construye el contenido de una página. Coordenadas en puntos, origen abajo a la izquierda (como en PDF). */
export class PdfCanvas {
  private ops: string[] = [];

  raw(op: string): this {
    this.ops.push(op);
    return this;
  }
  save(): this {
    return this.raw('q');
  }
  restore(): this {
    return this.raw('Q');
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    return this.raw(`${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} cm`);
  }
  lineWidth(w: number): this {
    return this.raw(`${num(w)} w`);
  }
  dash(pattern: number[], phase = 0): this {
    return this.raw(`[${pattern.map(num).join(' ')}] ${num(phase)} d`);
  }
  strokeColor(r: number, g: number, b: number): this {
    return this.raw(`${num(r)} ${num(g)} ${num(b)} RG`);
  }
  fillColor(r: number, g: number, b: number): this {
    return this.raw(`${num(r)} ${num(g)} ${num(b)} rg`);
  }
  moveTo(x: number, y: number): this {
    return this.raw(`${num(x)} ${num(y)} m`);
  }
  lineTo(x: number, y: number): this {
    return this.raw(`${num(x)} ${num(y)} l`);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    return this.raw(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c`);
  }
  rect(x: number, y: number, w: number, h: number): this {
    return this.raw(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`);
  }
  closePath(): this {
    return this.raw('h');
  }
  stroke(): this {
    return this.raw('S');
  }
  fill(): this {
    return this.raw('f');
  }
  fillStroke(): this {
    return this.raw('B');
  }
  line(x1: number, y1: number, x2: number, y2: number): this {
    return this.moveTo(x1, y1).lineTo(x2, y2).stroke();
  }
  polyline(pts: readonly (readonly [number, number])[], close = false): this {
    pts.forEach(([x, y], i) => (i === 0 ? this.moveTo(x, y) : this.lineTo(x, y)));
    if (close) this.closePath();
    return this.stroke();
  }
  /** Arco circular como curvas Bézier (tramos de 90° como máximo), igual que lo escribe un trazador de CAD. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, move = true): this {
    const sweep = a1 - a0;
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const k = (4 / 3) * Math.tan(step / 4);
    if (move) this.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + step * i;
      const t1 = t0 + step;
      this.curveTo(
        cx + r * (Math.cos(t0) - k * Math.sin(t0)),
        cy + r * (Math.sin(t0) + k * Math.cos(t0)),
        cx + r * (Math.cos(t1) + k * Math.sin(t1)),
        cy + r * (Math.sin(t1) - k * Math.cos(t1)),
        cx + r * Math.cos(t1),
        cy + r * Math.sin(t1),
      );
    }
    return this;
  }
  circle(cx: number, cy: number, r: number): this {
    return this.arc(cx, cy, r, 0, 2 * Math.PI).closePath();
  }
  /** Texto con Helvetica. `angle` en radianes (antihorario). `bold` usa Helvetica-Bold. */
  text(x: number, y: number, size: number, text: string, opts: { angle?: number; bold?: boolean; align?: 'left' | 'center' | 'right' } = {}): this {
    const w = helveticaWidth(text, size, opts.bold);
    const dx = opts.align === 'center' ? -w / 2 : opts.align === 'right' ? -w : 0;
    const c = Math.cos(opts.angle ?? 0);
    const s = Math.sin(opts.angle ?? 0);
    return this.raw(`BT /${opts.bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(x + dx * c)} ${num(y + dx * s)} Tm ${pdfString(text)} Tj ET`);
  }
  beginLayer(index: number): this {
    return this.raw(`/OC /L${index} BDC`);
  }
  endLayer(): this {
    return this.raw('EMC');
  }
  toString(): string {
    return this.ops.join('\n');
  }
}

// Anchos de Helvetica (unidades de 1/1000 de em) para los caracteres ASCII 32–126; el resto se aproxima.
const HELV =
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'
    .split(',')
    .map(Number);

export function helveticaWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    w += code >= 32 && code <= 126 ? HELV[code - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

export function buildPdf(pages: MiniPdfPage[], opts: MiniPdfOptions = {}): Uint8Array {
  const enc = new TextEncoder();
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const layerNames = opts.layers ?? [];

  const catalogId = add('');
  const pagesId = add('');
  const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const ocgIds = layerNames.map((name) => add(`<< /Type /OCG /Name ${pdfString(name)} >>`));
  const props = ocgIds.length ? ` /Properties << ${ocgIds.map((id, i) => `/L${i} ${id} 0 R`).join(' ')} >>` : '';
  const resources = `<< /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >>${props} >>`;

  const pageIds: number[] = [];
  for (const p of pages) {
    const bytes = enc.encode(p.content).length;
    const contentId = add(`<< /Length ${bytes} >>\nstream\n${p.content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}]${p.rotate ? ` /Rotate ${p.rotate}` : ''}${p.userUnit && p.userUnit !== 1 ? ` /UserUnit ${num(p.userUnit)}` : ''} /Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const hidden = new Set(opts.hiddenLayers ?? []);
  const refs = (filter: (i: number) => boolean) =>
    ocgIds
      .filter((_, i) => filter(i))
      .map((id) => `${id} 0 R`)
      .join(' ');
  const oc = ocgIds.length ? ` /OCProperties << /OCGs [${refs(() => true)}] /D << /Order [${refs(() => true)}] /ON [${refs((i) => !hidden.has(i))}] /OFF [${refs((i) => hidden.has(i))}] >> >>` : '';
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${oc} >>`;
  const infoId = add(`<< /Title ${pdfString(opts.title ?? 'Plano')} /Producer (Metrado Lab) >>`);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const write = (s: string) => {
    const b = enc.encode(s);
    chunks.push(b);
    offset += b.length;
  };
  write('%PDF-1.7\n%âãÏÓ\n');
  objects.forEach((body, i) => {
    offsets.push(offset);
    write(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = offset;
  write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
