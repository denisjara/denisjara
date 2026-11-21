import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildXlsx, cellRef, colName, type CellInput, type CellStyle, type SheetSpec } from '../src/io/xlsx';
import { readZip } from '../src/io/zip';

const tmp = mkdtempSync(join(tmpdir(), 'metrado-xlsx-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ───────────────────────────── Libro de prueba: dos hojas que usan todas las funciones ─────────────────────────────

const head: CellStyle = { bold: true, fill: '#DDEEFF', border: true, align: 'center', valign: 'center', wrap: true };
const partial: CellStyle = { numFmt: '0.00', border: true };
const total: CellStyle = { numFmt: '#,##0.00', border: true, bold: true, fill: '#ffe699' };
const note: CellStyle = { italic: true, size: 8, color: '#C00000', align: 'left', valign: 'top', wrap: true };
const title: CellStyle = { bold: true, size: 14, color: '#1f4e79', fill: '#f2f2f2', align: 'center', valign: 'bottom' };
const partialOf = (row: number): CellInput => ({ f: `ROUND(B${row}*PRODUCT(C${row}:E${row}),2)`, s: partial });

const METRADO: SheetSpec = {
  name: 'Metrado: Eje 1/2', // «:» y «/» no valen en un nombre de hoja
  rows: [
    ['Descripción', 'N.º de veces — Ñandú', 'Largo', 'Ancho', 'Alto', 'Parcial'].map((v) => ({ v, s: head })),
    ['Zapata Z-1', 40, 1.5, 1.2, 0.6, partialOf(2)],
    ['Viga V-101', 2, 4.25, 0.25, 0.5, { f: 'ROUND(B3*PRODUCT(C3:E3),2)', v: 1.06, s: partial }],
    ['Losa (sin alto)', 250, 3.3, 2.1, null, partialOf(4)],
    ['Descuento por vano', 1, -0.75, 1.2, 0.1 + 0.2, partialOf(5)],
    [{ v: 'TOTAL', s: { bold: true, align: 'right' } }, { s: partial }, { s: partial }, { s: partial }, { s: partial }, { f: 'SUM(F2:F5)', s: total }],
    ['=1+1', '+51 999 888 777', '-x', '@usuario', 0.1 + 0.2, true],
    ['  dos espacios  ', 'dos\r\nlíneas', 'a_x0041_b', '<a href="x">Tom & Jerry</a>', `ctrl${String.fromCharCode(1, 11)}char`, `🏗 obra ${String.fromCharCode(0xd83c)}`],
    [1e21, 1e-7, -0, NaN, Infinity, { f: 'A2&" (ref)"', v: 'Zapata Z-1 (ref)' }],
    [false, '', null, undefined, { v: '', s: note }, { f: "'Resumen f''c'!C4*2", s: partial }],
    [],
    [{ v: 'Nota: metrado referencial.\nVerificar en obra.', s: note }, { s: note }, { s: note }, { s: note }, { s: note }, { s: note }],
  ],
  colWidths: [30, 12, 10, 10, 10, 14],
  rowHeights: { 0: 30, 11: 28.5, 14: 20 },
  merges: ['A12:F12'],
  freezeRows: 1,
  freezeCols: 1,
  landscape: true,
  printTitleRows: 1,
};

const RESUMEN: SheetSpec = {
  name: "Resumen f'c",
  rows: [
    [{ v: 'Resumen de metrados', s: title }, { s: title }, { s: title }],
    ['Partida', 'Unidad', 'Metrado'].map((v) => ({ v, s: head })),
    ["Concreto f'c=210 kg/cm²", 'm³', { f: "'Metrado_ Eje 1_2'!F6", s: total }],
    ['Acero corrugado', 'kg', { v: 1234.5, s: { numFmt: '0.000' } }],
    ['Encofrado', 'm²', { v: 0, s: { numFmt: '0' } }],
    ['Código', { v: '007', s: { numFmt: '@' } }, { v: -1234567.891, s: { numFmt: '#,##0' } }],
    ['Avance', null, { v: 0.256, s: { numFmt: '0.0%' } }],
    ['Área', null, { v: 12.5, s: { numFmt: '0.00" m²"' } }],
  ],
  colWidths: [40, 8, 14],
  rowHeights: { 0: 24 },
  merges: ['A1:C1'],
  freezeRows: 2,
  printTitleRows: 2,
};

const SHEETS = [METRADO, RESUMEN];
const NAMES = ['Metrado_ Eje 1_2', "Resumen f'c"];
const DATE = new Date(Date.UTC(2026, 10, 15, 15, 30, 45, 678));
const build = (): Uint8Array => buildXlsx(SHEETS, { creator: 'Denis & Cía.', title: 'Metrado <Eje 1/2>', date: DATE });

/** Lo que cualquier lector debe encontrar en cada celda escrita (las fórmulas, con su «=»). */
const VALUES: Record<string, string | number | boolean | null>[] = [
  {
    A1: 'Descripción', B1: 'N.º de veces — Ñandú', C1: 'Largo', D1: 'Ancho', E1: 'Alto', F1: 'Parcial',
    A2: 'Zapata Z-1', B2: 40, C2: 1.5, D2: 1.2, E2: 0.6, F2: '=ROUND(B2*PRODUCT(C2:E2),2)',
    A3: 'Viga V-101', B3: 2, C3: 4.25, D3: 0.25, E3: 0.5, F3: '=ROUND(B3*PRODUCT(C3:E3),2)',
    A4: 'Losa (sin alto)', B4: 250, C4: 3.3, D4: 2.1, F4: '=ROUND(B4*PRODUCT(C4:E4),2)',
    A5: 'Descuento por vano', B5: 1, C5: -0.75, D5: 1.2, E5: 0.30000000000000004, F5: '=ROUND(B5*PRODUCT(C5:E5),2)',
    A6: 'TOTAL', B6: null, C6: null, D6: null, E6: null, F6: '=SUM(F2:F5)',
    A7: '=1+1', B7: '+51 999 888 777', C7: '-x', D7: '@usuario', E7: 0.30000000000000004, F7: true,
    A8: '  dos espacios  ', B8: 'dos\nlíneas', C8: 'a_x0041_b', D8: '<a href="x">Tom & Jerry</a>', E8: 'ctrlchar', F8: '🏗 obra ',
    A9: 1e21, B9: 1e-7, C9: 0, F9: '=A2&" (ref)"',
    A10: false, E10: null, F10: "='Resumen f''c'!C4*2",
    A12: 'Nota: metrado referencial.\nVerificar en obra.', B12: null, C12: null, D12: null, E12: null, F12: null,
  },
  {
    A1: 'Resumen de metrados', B1: null, C1: null,
    A2: 'Partida', B2: 'Unidad', C2: 'Metrado',
    A3: "Concreto f'c=210 kg/cm²", B3: 'm³', C3: "='Metrado_ Eje 1_2'!F6",
    A4: 'Acero corrugado', B4: 'kg', C4: 1234.5,
    A5: 'Encofrado', B5: 'm²', C5: 0,
    A6: 'Código', B6: '007', C6: -1234567.891,
    A7: 'Avance', C7: 0.256,
    A8: 'Área', C8: 12.5,
  },
];

/** Estilo en una forma común para compararlo con lo que hay en el XML y con lo que lee openpyxl. */
const normalStyle = (s: CellStyle = {}) => ({
  numFmt: s.numFmt ?? 'General',
  bold: !!s.bold,
  italic: !!s.italic,
  size: s.size ?? 10,
  color: s.color ? `FF${s.color.slice(1).toUpperCase()}` : null,
  fill: s.fill ? `FF${s.fill.slice(1).toUpperCase()}` : null,
  align: s.align ?? null,
  valign: s.valign ?? null,
  wrap: !!s.wrap,
  border: !!s.border,
});
type NormalStyle = ReturnType<typeof normalStyle>;

/** Estilo pedido para cada celda de una hoja, por referencia. */
function requestedStyles(sheet: SheetSpec): Record<string, NormalStyle> {
  const out: Record<string, NormalStyle> = {};
  sheet.rows.forEach((row, r) =>
    row.forEach((input, c) => {
      out[cellRef(r, c)] = normalStyle(typeof input === 'object' && input !== null ? input.s : undefined);
    }),
  );
  return out;
}

// ───────────────────────────────────── Analizador XML mínimo y estricto ─────────────────────────────────────

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);|&/g, (_all, ref: string | undefined) => {
    if (ref === undefined) throw new Error('«&» sin escapar');
    if (ref.startsWith('#')) return String.fromCodePoint(ref[1] === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    if (!(ref in ENTITIES)) throw new Error(`entidad desconocida &${ref};`);
    return ENTITIES[ref];
  });
}

/** Lanza un error si el documento no está bien formado; si lo está, devuelve su elemento raíz. */
function parseXml(xml: string): XmlNode {
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  if (!xml.startsWith(declaration)) throw new Error('falta la declaración XML');
  for (const ch of xml) {
    const c = ch.codePointAt(0) ?? 0;
    const valid = c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000;
    if (!valid) throw new Error(`carácter no válido en XML: U+${c.toString(16)}`);
  }
  const doc: XmlNode = { tag: '', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const prefixes = new Set<string>();
  const token = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*)\s*(\/?)>|([^<]+)/y;
  let at = declaration.length;
  while (at < xml.length) {
    token.lastIndex = at;
    const m = token.exec(xml);
    if (!m) throw new Error(`XML mal formado en la posición ${at}: ${xml.slice(at, at + 40)}`);
    at = token.lastIndex;
    const [, closing, tag, rawAttrs, selfClosing, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (stack.length === 1) throw new Error('texto fuera del elemento raíz');
      top.text += unescapeXml(text);
    } else if (closing) {
      if (rawAttrs || selfClosing || stack.length === 1 || top.tag !== tag) throw new Error(`cierre inesperado: </${tag}>`);
      stack.pop();
    } else {
      if (stack.length === 1 && doc.children.length) throw new Error('más de un elemento raíz');
      const node: XmlNode = { tag, attrs: {}, children: [], text: '' };
      for (const [, name, value] of rawAttrs.matchAll(/([^\s=]+)="([^"]*)"/g)) {
        if (name in node.attrs) throw new Error(`atributo repetido: ${name}`);
        node.attrs[name] = unescapeXml(value);
      }
      for (const name of [tag, ...Object.keys(node.attrs)]) if (name.includes(':')) prefixes.add(name.split(':')[0]);
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length !== 1 || doc.children.length !== 1) throw new Error('quedan elementos sin cerrar');
  const root = doc.children[0];
  for (const prefix of prefixes) {
    if (prefix !== 'xml' && prefix !== 'xmlns' && !(`xmlns:${prefix}` in root.attrs)) throw new Error(`prefijo sin declarar: ${prefix}`);
  }
  return root;
}

const child = (node: XmlNode, tag: string): XmlNode | undefined => node.children.find((c) => c.tag === tag);

function must(node: XmlNode, ...path: string[]): XmlNode {
  let at = node;
  for (const tag of path) {
    const next = child(at, tag);
    if (!next) throw new Error(`falta <${tag}> dentro de <${at.tag}>`);
    at = next;
  }
  return at;
}

/** Los hijos de `node` están en el orden que fija el esquema, sin repetirse y sin elementos de más. */
function expectOrder(node: XmlNode, order: string[]): void {
  const tags = node.children.map((c) => c.tag);
  expect(order, `elementos de <${node.tag}>`).toEqual(expect.arrayContaining(tags));
  expect(tags).toEqual(order.filter((tag) => tags.includes(tag)));
}

const WORKSHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'mergeCells', 'printOptions', 'pageMargins', 'pageSetup'];
const WORKBOOK_ORDER = ['fileVersion', 'workbookPr', 'bookViews', 'sheets', 'definedNames', 'calcPr'];
const STYLES_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles'];
const BUILTIN_FORMATS: Record<string, string> = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 49: '@' };

const colIndex = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

async function unzipText(xlsx: Uint8Array): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  for (const entry of await readZip(xlsx)) parts.set(entry.name, new TextDecoder('utf-8', { fatal: true }).decode(await entry.read()));
  return parts;
}

/** Celdas de una hoja por referencia, comprobando de paso que filas y celdas van en orden creciente. */
function cellsOf(sheet: XmlNode): Map<string, XmlNode> {
  const cells = new Map<string, XmlNode>();
  let lastRow = 0;
  for (const row of must(sheet, 'sheetData').children) {
    expect(row.tag).toBe('row');
    expect(Number(row.attrs.r)).toBeGreaterThan(lastRow);
    lastRow = Number(row.attrs.r);
    let lastCol = -1;
    for (const cell of row.children) {
      const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(cell.attrs.r) ?? [];
      expect(cell.tag).toBe('c');
      expect(Number(digits)).toBe(lastRow);
      expect(colIndex(letters)).toBeGreaterThan(lastCol);
      lastCol = colIndex(letters);
      cells.set(cell.attrs.r, cell);
    }
  }
  return cells;
}

/** Estilo de una celda resuelto a través de styles.xml. */
function styleOf(cell: XmlNode, styles: XmlNode): NormalStyle {
  const xf = must(styles, 'cellXfs').children[Number(cell.attrs.s ?? 0)];
  const font = must(styles, 'fonts').children[Number(xf.attrs.fontId)];
  const fill = must(styles, 'fills').children[Number(xf.attrs.fillId)];
  const border = must(styles, 'borders').children[Number(xf.attrs.borderId)];
  const custom = child(styles, 'numFmts')?.children.find((f) => f.attrs.numFmtId === xf.attrs.numFmtId);
  const alignment = child(xf, 'alignment');
  expect(must(font, 'name').attrs.val).toBe('Arial');
  expect(['left', 'right', 'top', 'bottom'].map((side) => must(border, side).attrs.style)).toEqual(Array(4).fill(xf.attrs.borderId === '0' ? undefined : 'thin'));
  expect(xf.attrs.applyAlignment).toBe(alignment ? '1' : undefined);
  return {
    numFmt: custom ? custom.attrs.formatCode : BUILTIN_FORMATS[xf.attrs.numFmtId],
    bold: !!child(font, 'b'),
    italic: !!child(font, 'i'),
    size: Number(must(font, 'sz').attrs.val),
    color: child(font, 'color')?.attrs.rgb ?? null,
    fill: must(fill, 'patternFill').attrs.patternType === 'solid' ? must(fill, 'patternFill', 'fgColor').attrs.rgb : null,
    align: (alignment?.attrs.horizontal as NormalStyle['align']) ?? null,
    valign: (alignment?.attrs.vertical as NormalStyle['valign']) ?? null,
    wrap: alignment?.attrs.wrapText === '1',
    border: xf.attrs.borderId !== '0',
  };
}

// ───────────────────────────────────────────── Pruebas ─────────────────────────────────────────────

describe('referencias de celda', () => {
  it('colName y cellRef', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 703, 16383].map(colName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'AAB', 'XFD']);
    for (const index of [0, 25, 26, 700, 5000, 16383]) expect(colIndex(colName(index))).toBe(index);
    expect(cellRef(0, 0)).toBe('A1');
    expect(cellRef(4, 3)).toBe('D5');
    expect(cellRef(1048575, 16383)).toBe('XFD1048576');
  });
});

describe('libro de dos hojas', () => {
  const xlsx = build();
  let parts: Map<string, string>;
  const part = (name: string): XmlNode => parseXml(parts.get(name) ?? '');
  beforeAll(async () => {
    parts = await unzipText(xlsx);
  });

  it('el paquete trae las partes esperadas, bien formadas y enlazadas entre sí', () => {
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    for (const name of parts.keys()) expect(() => part(name), name).not.toThrow();

    // Cada parte tiene su tipo de contenido y cada relación apunta a una parte que existe.
    const types = part('[Content_Types].xml');
    const overrides = types.children.filter((n) => n.tag === 'Override').map((n) => n.attrs.PartName);
    expect(overrides.sort()).toEqual([...parts.keys()].filter((name) => !/rels$|^\[/.test(name)).map((name) => `/${name}`).sort());
    expect(types.children.filter((n) => n.tag === 'Default').map((n) => n.attrs.Extension)).toEqual(['rels', 'xml']);
    expect(part('_rels/.rels').children.map((r) => r.attrs.Target)).toEqual(['xl/workbook.xml', 'docProps/core.xml', 'docProps/app.xml']);
    const rels = part('xl/_rels/workbook.xml.rels').children.map((r) => r.attrs);
    expect(rels.map((r) => [r.Id, r.Target, r.Type.split('/').pop()])).toEqual([
      ['rId1', 'worksheets/sheet1.xml', 'worksheet'],
      ['rId2', 'worksheets/sheet2.xml', 'worksheet'],
      ['rId3', 'styles.xml', 'styles'],
    ]);

    const core = part('docProps/core.xml');
    expect(must(core, 'dc:title').text).toBe('Metrado <Eje 1/2>');
    expect(must(core, 'dc:creator').text).toBe('Denis & Cía.');
    expect(must(core, 'dcterms:created').text).toBe('2026-11-15T15:30:45Z');
    expect(must(core, 'dcterms:modified').attrs['xsi:type']).toBe('dcterms:W3CDTF');
    expect(must(part('docProps/app.xml'), 'Application').text).toBe('Metrado Lab');
  });

  it('workbook.xml: nombres de hoja corregidos, títulos de impresión y recálculo al abrir', () => {
    const workbook = part('xl/workbook.xml');
    expectOrder(workbook, WORKBOOK_ORDER);
    expect(must(workbook, 'sheets').children.map((s) => s.attrs)).toEqual([
      { name: NAMES[0], sheetId: '1', 'r:id': 'rId1' },
      { name: NAMES[1], sheetId: '2', 'r:id': 'rId2' },
    ]);
    expect(must(workbook, 'definedNames').children.map((d) => [d.attrs.name, d.attrs.localSheetId, d.text])).toEqual([
      ['_xlnm.Print_Titles', '0', "'Metrado_ Eje 1_2'!$1:$1"],
      ['_xlnm.Print_Titles', '1', "'Resumen f''c'!$1:$2"],
    ]);
    expect(must(workbook, 'calcPr').attrs.fullCalcOnLoad).toBe('1');
  });

  it('hojas: orden de los elementos, paneles, anchos, altos, combinaciones y página', () => {
    const [metrado, resumen] = [part('xl/worksheets/sheet1.xml'), part('xl/worksheets/sheet2.xml')];
    for (const sheet of [metrado, resumen]) expectOrder(sheet, WORKSHEET_ORDER);
    expect(metrado.children.map((c) => c.tag)).toEqual(WORKSHEET_ORDER.filter((tag) => tag !== 'printOptions'));
    expect(resumen.children.map((c) => c.tag)).toEqual(['dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'mergeCells', 'pageMargins']);

    expect(must(metrado, 'dimension').attrs.ref).toBe('A1:F12');
    expect(must(resumen, 'dimension').attrs.ref).toBe('A1:C8');
    expect(must(metrado, 'sheetViews', 'sheetView').attrs).toEqual({ tabSelected: '1', workbookViewId: '0' });
    expect(must(resumen, 'sheetViews', 'sheetView').attrs).toEqual({ workbookViewId: '0' }); // solo una hoja seleccionada
    expect(must(metrado, 'sheetViews', 'sheetView', 'pane').attrs).toEqual({ xSplit: '1', ySplit: '1', topLeftCell: 'B2', activePane: 'bottomRight', state: 'frozen' });
    expect(must(resumen, 'sheetViews', 'sheetView', 'pane').attrs).toEqual({ ySplit: '2', topLeftCell: 'A3', activePane: 'bottomLeft', state: 'frozen' });
    expect(must(metrado, 'sheetViews', 'sheetView').children.map((c) => c.attrs.pane ?? c.tag)).toEqual(['pane', 'topRight', 'bottomLeft', 'bottomRight']);

    // 30 caracteres → (30 × 7 + 5) / 7 anchos de dígito, truncado a 1/256.
    expect(must(metrado, 'cols').children.map((c) => c.attrs)).toEqual(
      [30.7109375, 12.7109375, 10.7109375, 10.7109375, 10.7109375, 14.7109375].map((width, i) => ({ min: `${i + 1}`, max: `${i + 1}`, width: `${width}`, customWidth: '1' })),
    );
    const rows = must(metrado, 'sheetData').children;
    expect(rows.map((r) => Number(r.attrs.r))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]); // la 11 está vacía; la 15 solo tiene alto
    expect(rows.filter((r) => r.attrs.ht).map((r) => [r.attrs.r, r.attrs.ht, r.attrs.customHeight, r.children.length])).toEqual([
      ['1', '30', '1', 6],
      ['12', '28.5', '1', 6],
      ['15', '20', '1', 0],
    ]);
    expect(must(metrado, 'mergeCells').attrs.count).toBe('1');
    expect(must(metrado, 'mergeCells').children.map((m) => m.attrs.ref)).toEqual(['A12:F12']);
    expect(must(resumen, 'mergeCells').children.map((m) => m.attrs.ref)).toEqual(['A1:C1']);

    expect(must(metrado, 'sheetPr', 'pageSetUpPr').attrs).toEqual({ fitToPage: '1' });
    expect(must(metrado, 'pageSetup').attrs).toEqual({ paperSize: '9', orientation: 'landscape', fitToWidth: '1', fitToHeight: '0' });
    expect(child(resumen, 'pageSetup')).toBeUndefined();
  });

  it('celdas: tipos, textos en línea, fórmulas, números con toda su precisión y celdas vacías con estilo', () => {
    const sheets = [part('xl/worksheets/sheet1.xml'), part('xl/worksheets/sheet2.xml')];
    const [cells, cells2] = sheets.map(cellsOf);
    const get = (ref: string): XmlNode => cells.get(ref) ?? { tag: `falta ${ref}`, attrs: {}, children: [], text: '' };
    // Se escriben exactamente las celdas previstas (ni las vacías sin estilo, ni NaN, ni Infinity).
    expect([...cells.keys()].sort()).toEqual(Object.keys(VALUES[0]).sort());
    expect([...cells2.keys()].sort()).toEqual(Object.keys(VALUES[1]).sort());

    // Todo texto va en línea y toda fórmula en <f>; nada más lleva tipo.
    sheets.forEach((_sheet, i) => {
      for (const [ref, cell] of i ? cells2 : cells) {
        const expected = VALUES[i][ref];
        const formula = child(cell, 'f');
        if (typeof expected === 'string' && expected.startsWith('=') && formula) {
          expect(formula.text, ref).toBe(expected.slice(1));
          expect(child(cell, 'is'), ref).toBeUndefined();
        } else if (typeof expected === 'string') {
          expect(cell.attrs.t, ref).toBe('inlineStr');
          expect(cell.children.map((c) => c.tag), ref).toEqual(['is']);
          if (ref !== 'C8' || i) expect(must(cell, 'is', 't').text, ref).toBe(expected);
        } else if (typeof expected === 'number') {
          expect(cell.attrs.t, ref).toBeUndefined();
          expect(Number(must(cell, 'v').text), ref).toBe(expected);
          expect(cell.children.length, ref).toBe(1);
        } else if (typeof expected === 'boolean') {
          expect([cell.attrs.t, must(cell, 'v').text], ref).toEqual(['b', expected ? '1' : '0']);
        } else {
          expect(cell.children, ref).toEqual([]); // vacía: solo estilo
          expect(Number(cell.attrs.s), ref).toBeGreaterThan(0);
        }
      }
    });

    // Detalles que no se ven en la tabla de arriba.
    expect(must(get('E5'), 'v').text).toBe('0.30000000000000004');
    expect(must(get('C5'), 'v').text).toBe('-0.75');
    expect(must(get('A9'), 'v').text).toBe('1e+21');
    expect(must(get('B9'), 'v').text).toBe('1e-7');
    expect(must(get('C9'), 'v').text).toBe('0'); // -0
    expect(get('F2').children.map((c) => c.tag)).toEqual(['f']); // sin valor en caché
    expect(get('F3').children.map((c) => [c.tag, c.text])).toEqual([['f', 'ROUND(B3*PRODUCT(C3:E3),2)'], ['v', '1.06']]);
    expect([get('F9').attrs.t, ...get('F9').children.map((c) => c.text)]).toEqual(['str', 'A2&" (ref)"', 'Zapata Z-1 (ref)']);
    expect(must(get('A8'), 'is', 't').attrs).toEqual({ 'xml:space': 'preserve' });
    expect(must(get('F8'), 'is', 't').attrs).toEqual({ 'xml:space': 'preserve' });
    expect(must(get('B8'), 'is', 't').attrs).toEqual({});
    expect(must(get('C8'), 'is', 't').text).toBe('a_x005F_x0041_b'); // Excel leería _x0041_ como «A»
    const raw = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(raw).toContain('<t>&lt;a href="x"&gt;Tom &amp; Jerry&lt;/a&gt;</t>');
    expect(raw).toContain('<f>A2&amp;" (ref)"</f>');
    expect(raw).not.toContain('\r');
  });

  it('una cadena que empieza por =, +, - o @ es texto, nunca una fórmula', () => {
    const cells = cellsOf(part('xl/worksheets/sheet1.xml'));
    for (const [ref, value] of [['A7', '=1+1'], ['B7', '+51 999 888 777'], ['C7', '-x'], ['D7', '@usuario']]) {
      const cell = cells.get(ref);
      expect(cell?.attrs.t).toBe('inlineStr');
      expect(cell?.children.map((c) => c.tag)).toEqual(['is']);
      expect(cell && must(cell, 'is', 't').text).toBe(value);
    }
    const evil = ['=HYPERLINK("http://x","y")', '=cmd|\' /C calc\'!A0', '+1+1', '-2+3', '@SUM(1,1)', '\t=1+1', '="a"&"b"'];
    const xml = [...unzipSync(buildXlsx([{ name: 'x', rows: [evil, evil.map((v) => ({ v, s: { bold: true } }))] }]))].join('');
    expect(xml).not.toContain('<f>');
  });

  it('estilos: deduplicados y con los formatos numéricos de serie reutilizados', () => {
    const styles = part('xl/styles.xml');
    expectOrder(styles, STYLES_ORDER);
    for (const tag of ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles']) {
      expect(must(styles, tag).attrs.count, tag).toBe(`${must(styles, tag).children.length}`);
    }
    // Los dos rellenos obligatorios van primero; después, un relleno por color distinto.
    expect(must(styles, 'fills').children.map((f) => must(f, 'patternFill').attrs.patternType)).toEqual(['none', 'gray125', 'solid', 'solid', 'solid']);
    expect(must(styles, 'fills').children.slice(2).map((f) => must(f, 'patternFill', 'fgColor').attrs.rgb)).toEqual(['FFDDEEFF', 'FFFFE699', 'FFF2F2F2']);
    // Fuentes: normal, negrita, nota (cursiva 8 roja) y título (negrita 14 azul).
    expect(must(styles, 'fonts').children.map((f) => f.children.map((c) => `${c.tag}${c.attrs.val ?? c.attrs.rgb ?? ''}`).join(' '))).toEqual([
      'sz10 nameArial family2',
      'b sz10 nameArial family2',
      'i sz8 colorFFC00000 nameArial family2',
      'b sz14 colorFF1F4E79 nameArial family2',
    ]);
    expect(must(styles, 'borders').children).toHaveLength(2);
    // Solo se declaran los formatos que Excel no trae de serie, desde el 164.
    expect(must(styles, 'numFmts').children.map((f) => f.attrs)).toEqual([
      { numFmtId: '164', formatCode: '0.000' },
      { numFmtId: '165', formatCode: '0.0%' },
      { numFmtId: '166', formatCode: '0.00" m²"' },
    ]);
    const xfs = must(styles, 'cellXfs').children;
    expect(xfs[0].attrs).toEqual({ numFmtId: '0', fontId: '0', fillId: '0', borderId: '0', xfId: '0' });
    expect(new Set(xfs.map((xf) => JSON.stringify(xf))).size).toBe(xfs.length);
    expect(xfs).toHaveLength(13); // 12 estilos distintos en uso + el normal
    expect(xfs.map((xf) => Number(xf.attrs.numFmtId)).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 49, 164, 165, 166]);

    // Cada celda lleva exactamente el estilo que se pidió.
    SHEETS.forEach((sheet, i) => {
      const cells = cellsOf(part(`xl/worksheets/sheet${i + 1}.xml`));
      const requested = requestedStyles(sheet);
      for (const [ref, cell] of cells) expect(styleOf(cell, styles), `${NAMES[i]}!${ref}`).toEqual(requested[ref]);
    });
  });

  it('openpyxl abre el libro sin avisos y lee lo mismo que se escribió', (ctx) => {
    try {
      execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'pipe' });
    } catch {
      return ctx.skip('python3 u openpyxl no están disponibles: no se validó el libro con openpyxl');
    }
    const path = join(tmp, 'metrado.xlsx');
    writeFileSync(path, xlsx);
    const script = `
import json, sys, warnings, zipfile
import xml.etree.ElementTree as ET
warnings.simplefilter('error')
import openpyxl

with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    for name in z.namelist():
        ET.fromstring(z.read(name))  # expat: cada parte está bien formada

wb = openpyxl.load_workbook(sys.argv[1])
def style(c):
    return {
        'numFmt': c.number_format, 'bold': bool(c.font.b), 'italic': bool(c.font.i), 'size': c.font.sz,
        'color': c.font.color.rgb if c.font.color else None,
        'fill': c.fill.fgColor.rgb if c.fill.fill_type == 'solid' else None,
        'align': c.alignment.horizontal, 'valign': c.alignment.vertical, 'wrap': bool(c.alignment.wrap_text),
        'border': [getattr(c.border, side).style for side in ('left', 'right', 'top', 'bottom')] == ['thin'] * 4,
        'font': c.font.name,
    }
out = {
    'names': wb.sheetnames, 'creator': wb.properties.creator, 'title': wb.properties.title,
    'created': wb.properties.created.isoformat(), 'fullCalcOnLoad': wb.calculation.fullCalcOnLoad, 'sheets': [],
}
for ws in wb.worksheets:
    cells = [c for row in ws.iter_rows() for c in row if c.value is not None or c.has_style]
    out['sheets'].append({
        'dimensions': ws.dimensions, 'freeze': ws.freeze_panes, 'selected': bool(ws.sheet_view.tabSelected),
        'merged': sorted(str(r) for r in ws.merged_cells.ranges),
        'widths': {k: d.width for k, d in ws.column_dimensions.items()},
        'heights': {str(k): d.height for k, d in ws.row_dimensions.items() if d.height is not None},
        'printTitleRows': ws.print_title_rows, 'orientation': ws.page_setup.orientation, 'paperSize': ws.page_setup.paperSize,
        'fitToWidth': ws.page_setup.fitToWidth, 'fitToHeight': ws.page_setup.fitToHeight,
        'fitToPage': bool(ws.sheet_properties.pageSetUpPr and ws.sheet_properties.pageSetUpPr.fitToPage),
        'values': {c.coordinate: c.value for c in cells},
        'types': {c.coordinate: c.data_type for c in cells},
        'styles': {c.coordinate: style(c) for c in cells},
    })
print(json.dumps(out))
`;
    interface Dump {
      names: string[];
      creator: string;
      title: string;
      created: string;
      fullCalcOnLoad: boolean;
      sheets: {
        dimensions: string;
        freeze: string | null;
        selected: boolean;
        merged: string[];
        widths: Record<string, number>;
        heights: Record<string, number>;
        printTitleRows: string | null;
        orientation: string | null;
        paperSize: number | null;
        fitToWidth: number | null;
        fitToHeight: number | null;
        fitToPage: boolean;
        values: Record<string, string | number | boolean | null>;
        types: Record<string, string>;
        styles: Record<string, NormalStyle & { font: string }>;
      }[];
    }
    const dump = JSON.parse(execFileSync('python3', ['-c', script, path], { stdio: ['ignore', 'pipe', 'inherit'] }).toString()) as Dump;

    expect(dump.names).toEqual(NAMES);
    expect([dump.creator, dump.title, dump.created, dump.fullCalcOnLoad]).toEqual(['Denis & Cía.', 'Metrado <Eje 1/2>', '2026-11-15T15:30:45', true]);

    dump.sheets.forEach((sheet, i) => {
      // openpyxl no deshace el escape _x005F_ de las cadenas; Excel y LibreOffice sí (ver la prueba siguiente).
      const expected = { ...VALUES[i] };
      if (i === 0 && sheet.values.C8 === 'a_x005F_x0041_b') expected.C8 = 'a_x005F_x0041_b';
      // openpyxl convierte en MergedCell (sin valor ni estilo propios) las celdas absorbidas por una combinación:
      // no aparecen en el volcado. Las combinaciones de la prueba son de una sola letra de columna.
      for (const range of SHEETS[i].merges ?? []) {
        const m = /^([A-Z])(\d+):([A-Z])(\d+)$/.exec(range);
        if (!m) continue;
        for (let c = m[1].charCodeAt(0); c <= m[3].charCodeAt(0); c++) {
          for (let r = Number(m[2]); r <= Number(m[4]); r++) {
            const ref = `${String.fromCharCode(c)}${r}`;
            if (ref !== `${m[1]}${m[2]}`) delete expected[ref];
          }
        }
      }
      expect(sheet.values, NAMES[i]).toEqual(expected);
      for (const [ref, value] of Object.entries(expected)) {
        const type = typeof value === 'string' ? (value.startsWith('=') && !/^[AC]7$/.test(ref) ? 'f' : 's') : typeof value === 'boolean' ? 'b' : 'n';
        expect(sheet.types[ref], `${NAMES[i]}!${ref}`).toBe(type === 'f' && i === 0 && ref === 'A7' ? 's' : type);
      }
      const requested = requestedStyles(SHEETS[i]);
      for (const [ref, style] of Object.entries(sheet.styles)) expect(style, `${NAMES[i]}!${ref}`).toEqual({ ...requested[ref], font: 'Arial' });
    });
    expect(dump.sheets[0].types.A7).toBe('s'); // «=1+1» es texto
    expect(dump.sheets[0].types.F2).toBe('f');

    const [metrado, resumen] = dump.sheets;
    expect([metrado.dimensions, resumen.dimensions]).toEqual(['A1:F12', 'A1:C8']); // openpyxl la recalcula con las celdas que tienen contenido (la fila 15 solo tiene alto)
    expect([metrado.freeze, resumen.freeze]).toEqual(['B2', 'A3']);
    expect([metrado.selected, resumen.selected]).toEqual([true, false]);
    expect([metrado.merged, resumen.merged]).toEqual([['A12:F12'], ['A1:C1']]);
    expect(metrado.widths).toEqual({ A: 30.7109375, B: 12.7109375, C: 10.7109375, D: 10.7109375, E: 10.7109375, F: 14.7109375 });
    expect(resumen.widths).toEqual({ A: 40.7109375, B: 8.7109375, C: 14.7109375 });
    expect([metrado.heights, resumen.heights]).toEqual([{ 1: 30, 12: 28.5, 15: 20 }, { 1: 24 }]);
    expect([metrado.printTitleRows, resumen.printTitleRows]).toEqual(['$1:$1', '$1:$2']);
    expect([metrado.orientation, metrado.paperSize, metrado.fitToWidth, metrado.fitToHeight, metrado.fitToPage]).toEqual(['landscape', 9, 1, 0, true]);
    expect([resumen.orientation, resumen.paperSize, resumen.fitToPage]).toEqual([null, null, false]);
  });

  it('LibreOffice abre el libro y calcula las fórmulas', { timeout: 180_000 }, (ctx) => {
    const path = join(tmp, 'recalculo.xlsx');
    writeFileSync(path, xlsx);
    // Coma, comillas, UTF-8 y celdas «tal como se muestran», para ver también los formatos numéricos aplicados.
    const filter = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false';
    const profile = `-env:UserInstallation=${pathToFileURL(join(tmp, 'perfil-lo')).href}`;
    try {
      execFileSync('soffice', [profile, '--headless', '--norestore', '--convert-to', filter, '--outdir', join(tmp, 'csv'), path], {
        timeout: 120_000,
        stdio: 'pipe',
        env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', LANGUAGE: 'en_US' },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return ctx.skip('LibreOffice (soffice) no está instalado: no se recalculó el libro');
      if (code === 'ETIMEDOUT') return ctx.skip('LibreOffice no terminó en 120 s: no se recalculó el libro');
      throw error;
    }
    const rows = parseCsv(readFileSync(join(tmp, 'csv', 'recalculo.csv'), 'utf8'));

    expect(rows[0]).toEqual(['Descripción', 'N.º de veces — Ñandú', 'Largo', 'Ancho', 'Alto', 'Parcial']);
    // Parciales = ROUND(veces × PRODUCT(largo:alto), 2) con formato 0.00; PRODUCT ignora la celda vacía de la losa.
    expect(rows[1]).toEqual(['Zapata Z-1', '40', '1.5', '1.2', '0.6', '43.20']);
    expect(rows[2]).toEqual(['Viga V-101', '2', '4.25', '0.25', '0.5', '1.06']);
    expect(rows[3]).toEqual(['Losa (sin alto)', '250', '3.3', '2.1', '', '1732.50']);
    expect(rows[4]).toEqual(['Descuento por vano', '1', '-0.75', '1.2', '0.3', '-0.27']);
    const partials = [40 * 1.5 * 1.2 * 0.6, 2 * 4.25 * 0.25 * 0.5, 250 * 3.3 * 2.1, -0.75 * 1.2 * (0.1 + 0.2)].map((x) => Math.round(x * 100) / 100);
    expect(rows.slice(1, 5).map((row) => Number(row[5]))).toEqual(partials);
    // SUM(F2:F5) con formato #,##0.00.
    expect(rows[5]).toEqual(['TOTAL', '', '', '', '', '1,776.49']);
    expect(Number(rows[5][5].replace(',', ''))).toBeCloseTo(partials.reduce((a, b) => a + b), 9);
    // Los textos que parecen fórmulas siguen siendo textos.
    expect(rows[6]).toEqual(['=1+1', '+51 999 888 777', '-x', '@usuario', '0.3', 'TRUE']);
    expect(rows[7]).toEqual(['  dos espacios  ', 'dos\nlíneas', 'a_x0041_b', '<a href="x">Tom & Jerry</a>', 'ctrlchar', '🏗 obra ']);
    expect(Number(rows[8][0])).toBe(1e21);
    expect(Number(rows[8][1])).toBe(1e-7);
    expect(rows[8].slice(2)).toEqual(['0', '', '', 'Zapata Z-1 (ref)']);
    // Fórmula que lee la otra hoja por su nombre (con apóstrofo): 2 × 1234.5.
    expect(rows[9]).toEqual(['FALSE', '', '', '', '', '2469.00']);
    expect(rows[10]).toEqual(['', '', '', '', '', '']);
    expect(rows[11]).toEqual(['Nota: metrado referencial.\nVerificar en obra.', '', '', '', '', '']);
  });
});

/** Las partes de un .xlsx como texto, de forma síncrona (todas van sin comprimir, una tras otra). */
function* unzipSync(xlsx: Uint8Array): Generator<string> {
  const view = new DataView(xlsx.buffer, xlsx.byteOffset, xlsx.byteLength);
  for (let p = 0; view.getUint32(p, true) === 0x04034b50; ) {
    const size = view.getUint32(p + 18, true);
    const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
    yield new TextDecoder().decode(xlsx.subarray(start, start + size));
    p = start + size;
  }
}

/** CSV con comillas dobles (RFC 4180) → filas de campos. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\n') {
      row.push(field);
      field = '';
      if (c === '\n') {
        rows.push(row);
        row = [];
      }
    } else if (c !== '\r') field += c;
  }
  return rows;
}

describe('entradas defectuosas: el libro sigue siendo válido', () => {
  const sheetNames = async (names: string[]): Promise<string[]> => {
    const parts = await unzipText(buildXlsx(names.map((name) => ({ name, rows: [] }))));
    return must(parseXml(parts.get('xl/workbook.xml') ?? ''), 'sheets').children.map((s) => s.attrs.name);
  };
  const sheetOf = async (sheet: Partial<SheetSpec>): Promise<XmlNode> => {
    const parts = await unzipText(buildXlsx([{ name: 'Hoja', rows: [], ...sheet }]));
    return parseXml(parts.get('xl/worksheets/sheet1.xml') ?? '');
  };

  it('nombres de hoja: caracteres prohibidos, longitud, vacíos, repetidos y reservados', async () => {
    const long = 'Lámina A-01 Planta de cimentación y detalles';
    expect(
      await sheetNames(['Hoja', 'hoja', 'HOJA', '', "  'entre comillas'  ", long, long, '[a]:b*c?d/e\\f', 'History', 'historial', 'con\ttab', `${'a'.repeat(30)}🏗`, 'Hoja 4']),
    ).toEqual([
      'Hoja',
      'hoja (2)',
      'HOJA (3)',
      'Hoja 4',
      'entre comillas',
      'Lámina A-01 Planta de cimentaci',
      'Lámina A-01 Planta de cimen (2)',
      '_a__b_c_d_e_f',
      'History_',
      'historial_',
      'con tab',
      'a'.repeat(30),
      'Hoja 4 (2)',
    ]);
    expect(await sheetNames([])).toEqual(['Hoja 1']); // un libro necesita al menos una hoja
  });

  it('combinaciones: se ignoran las mal escritas, las de una celda y las que pisan a otra', async () => {
    const sheet = await sheetOf({ merges: ['B2:C3', 'C3:D4', 'A1:A1', 'D1:B1', 'x', 'A0:B1', 'A5:XFE5', 'a7:b7', 'E5:F6', 'B2:C3'] });
    expect(must(sheet, 'mergeCells').attrs.count).toBe('3');
    expect(must(sheet, 'mergeCells').children.map((m) => m.attrs.ref)).toEqual(['B2:C3', 'B1:D1', 'E5:F6']);
    expect(child(await sheetOf({ merges: ['A1'] }), 'mergeCells')).toBeUndefined();
  });

  it('anchos, altos y paneles fuera de rango no se escriben o se acotan', async () => {
    const sheet = await sheetOf({ colWidths: [8.43, 0, -3, NaN, 1000], rowHeights: { 0: 0, 1: -5, 2: NaN, 3: 1000, 4: 12.5 }, freezeRows: -2, freezeCols: 2.9, printTitleRows: NaN });
    expect(must(sheet, 'cols').children.map((c) => [c.attrs.min, c.attrs.width])).toEqual([['1', '9.140625'], ['5', '255']]);
    expect(must(sheet, 'sheetData').children.map((r) => r.attrs)).toEqual([
      { r: '4', ht: '409.5', customHeight: '1' },
      { r: '5', ht: '12.5', customHeight: '1' },
    ]);
    expect(must(sheet, 'sheetViews', 'sheetView', 'pane').attrs).toEqual({ xSplit: '2', topLeftCell: 'C1', activePane: 'topRight', state: 'frozen' });
    expect(must(sheet, 'dimension').attrs.ref).toBe('A1');
    expect(child(await sheetOf({}), 'cols')).toBeUndefined();
  });

  it('colores no válidos, tamaños absurdos y fórmulas con «=» delante', async () => {
    const parts = await unzipText(
      buildXlsx([{ name: 'x', rows: [[{ v: 'a', s: { color: 'red', fill: '#12', size: -4 } }, { v: 1, s: { size: 5000, numFmt: '' } }, { f: '=A1&"<>"', s: {} }, { f: '', v: 5 }]] }]),
    );
    const styles = parseXml(parts.get('xl/styles.xml') ?? '');
    expect(must(styles, 'fonts').children).toHaveLength(1);
    expect(must(styles, 'fills').children).toHaveLength(2);
    expect(must(styles, 'cellXfs').children).toHaveLength(1);
    const cells = cellsOf(parseXml(parts.get('xl/worksheets/sheet1.xml') ?? ''));
    expect([...cells.values()].map((c) => c.attrs.s)).toEqual([undefined, undefined, undefined, undefined]);
    expect(cells.get('C1')?.children.map((c) => [c.tag, c.text])).toEqual([['f', 'A1&"<>"']]);
    expect(cells.get('D1')?.children.map((c) => [c.tag, c.text])).toEqual([['v', '5']]);
  });

  it('textos: caracteres no válidos en XML, sustitutos sueltos y celdas de más de 32 767 caracteres', async () => {
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
    const loneSurrogates = `a${String.fromCharCode(0xdc00)}b${String.fromCharCode(0xd800)}c${String.fromCharCode(0xfffe, 0xffff)}d`;
    const long = `${'x'.repeat(32766)}🏗 y más`;
    const sheet = await sheetOf({ rows: [[controls, loneSurrogates, long, 'ok 🏗 ñ']] });
    const texts = [...cellsOf(sheet).values()].map((c) => must(c, 'is', 't').text);
    expect(texts).toEqual(['\t\n\n', 'abcd', 'x'.repeat(32766), 'ok 🏗 ñ']);
  });

  it('lo que no cabe en una hoja de Excel se rechaza en vez de perder datos', () => {
    expect(() => buildXlsx([{ name: 'Ancha', rows: [Array.from({ length: 16385 }, () => 1)] }])).toThrow(/La hoja «Ancha» no cabe en Excel/);
    expect(() => buildXlsx([{ name: 'Larga', rows: Array.from({ length: 1048577 }, () => []) }])).toThrow(/La hoja «Larga» no cabe en Excel/);
    expect(() => buildXlsx([{ name: 'Justa', rows: [Array.from({ length: 16384 }, () => null)] }])).not.toThrow();
  });

  it('con la misma fecha el resultado es idéntico byte a byte; una fecha no válida no rompe nada', async () => {
    expect(Buffer.from(build()).equals(Buffer.from(build()))).toBe(true);
    const parts = await unzipText(buildXlsx(SHEETS, { date: new Date(NaN) }));
    expect(must(parseXml(parts.get('docProps/core.xml') ?? ''), 'dcterms:created').text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});
