/**
 * Exportación de la hoja de metrados: Excel (.xlsx con fórmulas), CSV y texto para pegar en una hoja de cálculo.
 *
 * El Excel lleva las medidas leídas del plano como valores y los parciales y totales como FÓRMULAS, con el mismo
 * redondeo que la app (ver core/metrado.ts): al abrirlo, cada número se puede auditar y cambiar.
 */
import { buildSheet, type MetradoRow, type PartidaBlock } from '../core/metrado';
import type { Project } from '../core/model';
import { buildXlsx, colName, type Cell, type CellInput, type CellStyle, type SheetSpec } from '../io/xlsx';

const COLS = ['Ítem', 'Descripción', 'Und.', 'N.º veces', 'Cant.', 'Largo', 'Ancho', 'Alto', 'Área', 'Factor', 'Parcial', 'Total', 'Lámina'] as const;
/** Columnas de las magnitudes que entran en el producto (E…J). */
const FACTOR_KEYS: (keyof MetradoRow)[] = ['cant', 'largo', 'ancho', 'alto', 'area', 'factor'];

export const rowLabel = (r: MetradoRow, index: number): string => r.label.trim() || `Medición ${index + 1}`;

function today(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export function fileBaseName(project: Project): string {
  const clean = project.name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `Metrados-${clean || 'proyecto'}`.slice(0, 80);
}

export function buildWorkbook(project: Project): Uint8Array {
  const blocks = buildSheet(project);
  const d = project.settings.decimals;
  const dec = `0.${'0'.repeat(d)}`;
  const total = `#,##0.${'0'.repeat(d)}`;
  const head: CellStyle = { bold: true, fill: '#1656C9', color: '#FFFFFF', align: 'center', valign: 'center', border: true, wrap: true };
  const band: CellStyle = { bold: true, fill: '#E3EAF2', border: true };
  const cell: CellStyle = { border: true };
  const num: CellStyle = { border: true, numFmt: dec, align: 'right' };
  const title: CellStyle = { bold: true, size: 14 };
  const muted: CellStyle = { color: '#64748B' };

  // --- Hoja de detalle -----------------------------------------------------
  const rows: CellInput[][] = [
    [{ v: 'HOJA DE METRADOS', s: title }],
    [{ v: `Proyecto: ${project.name}`, s: { bold: true } }],
    [{ v: `Fecha: ${today()} · Generado con Metrado Lab`, s: muted }],
    [],
    COLS.map((c): Cell => ({ v: c, s: head })),
  ];
  const totalRowOf = new Map<string, number>();
  for (const b of blocks) {
    const headerRow = rows.length;
    const first = headerRow + 2;
    const last = headerRow + 1 + b.rows.length;
    totalRowOf.set(b.partida.id, headerRow + 1);
    const bandCells: CellInput[] = COLS.map((): Cell => ({ s: band }));
    bandCells[0] = { v: b.partida.code, s: band };
    bandCells[1] = { v: b.partida.name, s: band };
    bandCells[2] = { v: b.partida.unit, s: { ...band, align: 'center' } };
    bandCells[11] = b.rows.length ? { f: `ROUND(SUM(K${first}:K${last}),${d})`, v: b.total, s: { ...band, numFmt: total, align: 'right' } } : { v: 0, s: { ...band, numFmt: total, align: 'right' } };
    rows.push(bandCells);
    b.rows.forEach((r, i) => {
      const n = rows.length + 1;
      const line: CellInput[] = COLS.map((): Cell => ({ s: cell }));
      line[1] = { v: `${rowLabel(r, i)}${r.issue === 'sin-escala' ? ' (sin escala)' : r.issue === 'falta-dato' ? ' (falta un dato)' : ''}`, s: cell };
      line[3] = { v: r.times, s: { border: true, numFmt: Number.isInteger(r.times) ? '0' : dec, align: 'right' } };
      FACTOR_KEYS.forEach((key, k) => {
        const v = r[key];
        if (typeof v === 'number') line[4 + k] = { v, s: key === 'cant' ? { border: true, numFmt: '0', align: 'right' } : key === 'factor' ? { border: true, numFmt: '0.####', align: 'right' } : num };
      });
      if (r.parcial !== null) line[10] = { f: `ROUND(D${n}*PRODUCT(E${n}:J${n}),${d})`, v: r.parcial, s: num };
      line[12] = { v: r.sheetName, s: { border: true, color: '#64748B' } };
      rows.push(line);
    });
  }
  const detail: SheetSpec = {
    name: 'Metrados',
    rows,
    colWidths: [10, 46, 7, 10, 8, 10, 10, 10, 10, 10, 12, 13, 26],
    merges: ['A1:M1', 'A2:M2', 'A3:M3'],
    freezeRows: 5,
    landscape: true,
    printTitleRows: 5,
    rowHeights: { 0: 22, 4: 30 },
  };

  // --- Resumen ---------------------------------------------------------------
  const sum: CellInput[][] = [[{ v: 'RESUMEN DE METRADOS', s: title }], [{ v: `Proyecto: ${project.name}`, s: { bold: true } }], [{ v: `Fecha: ${today()}`, s: muted }], [], ['Ítem', 'Descripción', 'Und.', 'Metrado'].map((c): Cell => ({ v: c, s: head }))];
  let group: string | undefined;
  for (const b of blocks) {
    if (b.partida.group && b.partida.group !== group) sum.push([{ s: band }, { v: b.partida.group.toUpperCase(), s: band }, { s: band }, { s: band }]);
    group = b.partida.group;
    const ref = totalRowOf.get(b.partida.id)!;
    sum.push([
      { v: b.partida.code, s: cell },
      { v: b.partida.name, s: cell },
      { v: b.partida.unit, s: { border: true, align: 'center' } },
      { f: `Metrados!${colName(11)}${ref}`, v: b.total, s: { border: true, numFmt: total, align: 'right' } },
    ]);
  }
  const summary: SheetSpec = { name: 'Resumen', rows: sum, colWidths: [10, 58, 8, 14], merges: ['A1:D1', 'A2:D2', 'A3:D3'], freezeRows: 5, rowHeights: { 0: 22 } };

  return buildXlsx([summary, detail], { creator: 'Metrado Lab', title: `Metrados - ${project.name}` });
}

/** Filas planas (una por medición y una de total por partida) para CSV y portapapeles. */
function flatRows(blocks: PartidaBlock[]): (string | number)[][] {
  const out: (string | number)[][] = [[...COLS]];
  for (const b of blocks) {
    out.push([b.partida.code, b.partida.name, b.partida.unit, '', '', '', '', '', '', '', '', b.total, '']);
    b.rows.forEach((r, i) => {
      out.push(['', rowLabel(r, i), '', r.times, r.cant ?? '', r.largo ?? '', r.ancho ?? '', r.alto ?? '', r.area ?? '', r.factor ?? '', r.parcial ?? '', '', r.sheetName]);
    });
  }
  return out;
}

/** Evita que una hoja de cálculo interprete un texto como fórmula al abrir el CSV. */
const safeText = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function buildCsv(project: Project): string {
  const q = (v: string | number): string => (typeof v === 'number' ? String(v) : `"${safeText(v).replace(/"/g, '""')}"`);
  return `﻿${flatRows(buildSheet(project))
    .map((r) => r.map(q).join(','))
    .join('\r\n')}\r\n`;
}

/** Texto separado por tabuladores: se pega directamente en Excel o Google Sheets. */
export function buildTsv(project: Project): string {
  const q = (v: string | number): string => (typeof v === 'number' ? String(v) : safeText(v).replace(/[\t\r\n]+/g, ' '));
  return flatRows(buildSheet(project))
    .map((r) => r.map(q).join('\t'))
    .join('\n');
}
