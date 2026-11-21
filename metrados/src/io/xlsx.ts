/**
 * Escritor mínimo de libros de Excel (.xlsx, SpreadsheetML) sin dependencias.
 *
 * Genera solo lo imprescindible para que Excel, LibreOffice y Google Sheets abran el archivo sin avisos de
 * reparación: tipos de contenido, relaciones, propiedades del documento, libro, estilos y una parte por hoja, todo
 * dentro de un ZIP sin comprimir (zip.ts).
 *
 * Decisiones:
 *   - Los textos van en línea (`t="inlineStr"`), sin tabla de cadenas compartidas. Un texto que empiece por =, +, -
 *     o @ sigue siendo texto: solo `Cell.f` produce una fórmula.
 *   - Los estilos se deduplican: cada fuente, relleno, borde, formato numérico y combinación de ellos se escribe una
 *     sola vez y las celdas la citan por su índice.
 *   - El libro pide recalcular al abrir (`fullCalcOnLoad`), así que el valor en caché de una fórmula es opcional:
 *     sirve a los visores que no calculan (vistas previas) y LibreOffice, si lo encuentra, no lo recalcula.
 *   - Ante una entrada defectuosa se prefiere un archivo válido: los nombres de hoja se corrigen, los colores no
 *     válidos y las combinaciones de celdas imposibles se ignoran y los números no finitos dejan la celda vacía.
 *     Solo se lanza un error si los datos no caben en la cuadrícula de Excel, porque entonces se perderían.
 *
 * No se validan los códigos de formato numérico ni la sintaxis de las fórmulas (en inglés y con comas, como se
 * guardan en el archivo): Excel ofrece reparar el libro si alguno no es correcto.
 */
import { zipStore } from './zip';

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  /** Tamaño de la fuente en puntos (por defecto 10; la fuente es siempre Arial). */
  size?: number;
  /** Color del texto, "#rrggbb". */
  color?: string;
  /** Color de fondo liso, "#rrggbb". */
  fill?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'center' | 'bottom';
  /** Ajustar el texto al ancho de la celda. */
  wrap?: boolean;
  /** Borde fino en los cuatro lados. */
  border?: boolean;
  /** Código de formato numérico de Excel: '0.00', '#,##0.00', '0', '@'… */
  numFmt?: string;
}

export type CellValue = string | number | boolean | null | undefined;

export interface Cell {
  /**
   * Valor de la celda o, si hay fórmula, su resultado en caché. Ese resultado es opcional, pero si se da tiene que
   * ser el correcto: Excel y Google Sheets recalculan al abrir, LibreOffice lo muestra tal cual.
   */
  v?: CellValue;
  /** Fórmula SIN el '=' inicial, p. ej. 'ROUND(D5*PRODUCT(E5:J5),2)'. */
  f?: string;
  s?: CellStyle;
}

export type CellInput = CellValue | Cell;

export interface SheetSpec {
  /** El escritor lo corrige: 31 caracteres como mucho, sin []:*?/\ y sin repetirse en el libro. */
  name: string;
  /** Por filas. null, undefined y '' dejan la celda vacía; una celda vacía con estilo ({ s }) sí se escribe. */
  rows: CellInput[][];
  /** Ancho de cada columna en caracteres de la fuente por defecto. */
  colWidths?: number[];
  /** Alto en puntos por índice de fila (base 0). */
  rowHeights?: Record<number, number>;
  /** Celdas combinadas, p. ej. ['A1:H1']. Se ignoran las de una sola celda, las mal escritas y las que pisan a otra anterior. */
  merges?: string[];
  /** Filas superiores que quedan inmovilizadas al desplazarse. */
  freezeRows?: number;
  freezeCols?: number;
  /** Configuración de página: A4 apaisado, ajustado a una página de ancho. */
  landscape?: boolean;
  /** Las primeras N filas se repiten en cada página impresa. */
  printTitleRows?: number;
}

export interface WorkbookOptions {
  creator?: string;
  title?: string;
  /** Fecha de creación del libro y de las entradas del ZIP (por defecto, ahora). */
  date?: Date;
}

const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
/** Excel no admite más caracteres en una celda. */
const MAX_TEXT = 32767;

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_PACKAGE = 'http://schemas.openxmlformats.org/package/2006';
const NS_OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006';
const MIME_OFFICE = 'application/vnd.openxmlformats-officedocument';
const MIME_PACKAGE = 'application/vnd.openxmlformats-package';

/** Lo que XML 1.0 no admite: controles (salvo tabulador, LF y CR), U+FFFE, U+FFFF y sustitutos sueltos. */
const INVALID_XML = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' };

/** Contenido de un elemento: sin caracteres no válidos y con & < > escapados (y CR, que el lector convertiría en LF). */
const text = (s: string): string => s.replace(INVALID_XML, '').replace(/[&<>\r]/g, (c) => ENTITIES[c]);

/** Valor de un atributo entre comillas dobles (tabulador y saltos como referencias: si no, se leerían como espacios). */
const attr = (s: string): string => s.replace(INVALID_XML, '').replace(/[&<>"\t\n\r]/g, (c) => ENTITIES[c]);

/** Formatos numéricos que Excel trae de serie; los demás se declaran a partir del id 164. */
const BUILTIN_FORMATS = new Map([['General', 0], ['0', 1], ['0.00', 2], ['#,##0', 3], ['#,##0.00', 4], ['@', 49]]);
const THIN_BORDER = `<border>${['left', 'right', 'top', 'bottom'].map((side) => `<${side} style="thin"><color auto="1"/></${side}>`).join('')}<diagonal/></border>`;

/** Letras de una columna: 0 → 'A', 25 → 'Z', 26 → 'AA'. */
export function colName(index0: number): string {
  let name = '';
  for (let n = index0 + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Referencia de una celda: (0, 0) → 'A1'. */
export const cellRef = (row0: number, col0: number): string => colName(col0) + (row0 + 1);

/** Entero entre 0 y `max` (0 si no es un número). */
const whole = (n: number | undefined, max: number): number => Math.min(Math.max(Math.trunc(n ?? 0) || 0, 0), max);

/** "#rrggbb" → "FFRRGGBB" (opaco), o undefined si no es un color válido. */
const argb = (hex?: string): string | undefined => (hex && /^#[0-9a-f]{6}$/i.test(hex) ? `FF${hex.slice(1).toUpperCase()}` : undefined);

/** Posición de `xml` en la lista, añadiéndolo si es nuevo. */
function intern(list: string[], xml: string): number {
  const i = list.indexOf(xml);
  return i >= 0 ? i : list.push(xml) - 1;
}

function fontXml(s: CellStyle): string {
  const size = typeof s.size === 'number' && s.size >= 1 && s.size <= 409 ? s.size : 10;
  const color = argb(s.color);
  return `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="${size}"/>${color ? `<color rgb="${color}"/>` : ''}<name val="Arial"/><family val="2"/></font>`;
}

/** Estilos del libro: `id` da el índice (atributo `s` de la celda) de un estilo y `xml`, la parte styles.xml. */
function createStyles(): { id(style: CellStyle): number; xml(): string } {
  const numFmts: string[] = [];
  const fonts = [fontXml({})];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']; // los dos obligatorios
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const list = (tag: string, items: string[]): string => `<${tag} count="${items.length}">${items.join('')}</${tag}>`;

  const id = (s: CellStyle): number => {
    const numFmtId = s.numFmt ? BUILTIN_FORMATS.get(s.numFmt) ?? 164 + intern(numFmts, s.numFmt) : 0;
    const fontId = intern(fonts, fontXml(s));
    const fill = argb(s.fill);
    const fillId = fill ? intern(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = s.border ? intern(borders, THIN_BORDER) : 0;
    const alignment =
      s.align || s.valign || s.wrap
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''}${s.valign ? ` vertical="${s.valign}"` : ''}${s.wrap ? ' wrapText="1"' : ''}/>`
        : '';
    const applied = `${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}`;
    return intern(
      xfs,
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${applied}${alignment ? ` applyAlignment="1">${alignment}</xf>` : '/>'}`,
    );
  };

  const xml = (): string =>
    `${XML}<styleSheet xmlns="${NS_MAIN}">` +
    (numFmts.length ? list('numFmts', numFmts.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${attr(code)}"/>`)) : '') +
    list('fonts', fonts) +
    list('fills', fills) +
    list('borders', borders) +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    list('cellXfs', xfs) +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  return { id, xml };
}

/** XML de una celda, o '' si no hay nada que escribir (vacía y sin estilo). */
function cellXml(ref: string, input: CellInput, styleId: (s: CellStyle) => number): string {
  const cell: Cell = typeof input === 'object' && input !== null ? input : { v: input };
  const style = cell.s ? styleId(cell.s) : 0;
  const open = `<c r="${ref}"${style ? ` s="${style}"` : ''}`;
  const f = cell.f ? `<f>${text(cell.f.replace(/^=/, ''))}</f>` : '';
  const v = cell.v;
  if (typeof v === 'number' && Number.isFinite(v)) return `${open}>${f}<v>${v}</v></c>`;
  if (typeof v === 'boolean') return `${open} t="b">${f}<v>${Number(v)}</v></c>`;
  if (typeof v === 'string') {
    if (f) return `${open} t="str">${f}<v>${text(v)}</v></c>`;
    // Excel solo usa LF como salto de línea y lee _xHHHH_ como un carácter escapado: el guion bajo se protege.
    const t = text(v.replace(/\r\n?/g, '\n').slice(0, MAX_TEXT)).replace(/_(?=x[0-9a-f]{4}_)/gi, '_x005F_');
    if (t) return `${open} t="inlineStr"><is><t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${t}</t></is></c>`;
  }
  return f ? `${open}>${f}</c>` : style ? `${open}/>` : '';
}

/** 'B2:D5' → [fila, columna, última fila, última columna] en base 0; null si no es un rango de varias celdas de la hoja. */
function parseRange(ref: string): number[] | null {
  const m = /^([A-Z]{1,3})(\d{1,7}):([A-Z]{1,3})(\d{1,7})$/.exec(ref);
  if (!m) return null;
  const col = (name: string): number => [...name].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const [c0, c1] = [col(m[1]), col(m[3])].sort((a, b) => a - b);
  const [r0, r1] = [Number(m[2]) - 1, Number(m[4]) - 1].sort((a, b) => a - b);
  return r0 >= 0 && r1 < MAX_ROWS && c1 < MAX_COLS && (r0 < r1 || c0 < c1) ? [r0, c0, r1, c1] : null;
}

/** Parte de una hoja. El orden de los elementos dentro de <worksheet> es obligatorio: Excel rechaza cualquier otro. */
function sheetXml(sheet: SheetSpec, styleId: (s: CellStyle) => number, selected: boolean): string {
  if (sheet.rows.length > MAX_ROWS || sheet.rows.some((row) => row.length > MAX_COLS)) {
    throw new Error(`La hoja «${sheet.name}» no cabe en Excel: el máximo es de 1 048 576 filas y 16 384 columnas`);
  }
  const heights = sheet.rowHeights ?? {};
  // Detrás de las filas con datos van, en orden, las que solo tienen un alto fijado.
  const tallRows = Object.keys(heights).map(Number).filter((r) => Number.isInteger(r) && r >= sheet.rows.length && r < MAX_ROWS);
  let [minRow, minCol, maxRow, maxCol] = [Infinity, Infinity, -1, -1];
  const rows: string[] = [];
  for (const r of [...sheet.rows.keys(), ...tallRows.sort((a, b) => a - b)]) {
    const cells = (sheet.rows[r] ?? []).map((input, c) => {
      const xml = cellXml(cellRef(r, c), input, styleId);
      if (xml) [minRow, minCol, maxRow, maxCol] = [Math.min(minRow, r), Math.min(minCol, c), r, Math.max(maxCol, c)];
      return xml;
    });
    const height = heights[r] > 0 ? ` ht="${Math.min(heights[r], 409.5)}" customHeight="1"` : '';
    if (height || cells.some(Boolean)) rows.push(`<row r="${r + 1}"${height}>${cells.join('')}</row>`);
  }
  const corners = maxRow < 0 ? ['A1'] : [cellRef(minRow, minCol), cellRef(maxRow, maxCol)];

  const freezeRows = whole(sheet.freezeRows, MAX_ROWS - 1);
  const freezeCols = whole(sheet.freezeCols, MAX_COLS - 1);
  const panes = freezeRows && freezeCols ? ['topRight', 'bottomLeft', 'bottomRight'] : freezeRows ? ['bottomLeft'] : freezeCols ? ['topRight'] : [];
  const pane = panes.length
    ? `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freezeRows ? ` ySplit="${freezeRows}"` : ''} topLeftCell="${cellRef(freezeRows, freezeCols)}"` +
      ` activePane="${panes[panes.length - 1]}" state="frozen"/>${panes.map((name) => `<selection pane="${name}"/>`).join('')}`
    : '';

  // El ancho se guarda en anchos de dígito (7 px en Arial 10) e incluye los 5 px de margen de la celda.
  const cols = (sheet.colWidths ?? [])
    .slice(0, MAX_COLS)
    .map((w, i) => (w > 0 ? `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.trunc(((w * 7 + 5) / 7) * 256) / 256, 255)}" customWidth="1"/>` : ''))
    .join('');

  const merges: number[][] = [];
  for (const ref of sheet.merges ?? []) {
    const m = parseRange(ref);
    if (m && !merges.some((o) => m[0] <= o[2] && o[0] <= m[2] && m[1] <= o[3] && o[1] <= m[3])) merges.push(m);
  }

  return (
    `${XML}<worksheet xmlns="${NS_MAIN}">` +
    (sheet.landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') +
    `<dimension ref="${corners[0] === corners[1] ? corners[0] : corners.join(':')}"/>` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"${pane ? `>${pane}</sheetView>` : '/>'}</sheetViews>` +
    '<sheetFormatPr defaultRowHeight="12.75"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map(([r0, c0, r1, c1]) => `<mergeCell ref="${cellRef(r0, c0)}:${cellRef(r1, c1)}"/>`).join('')}</mergeCells>` : '') +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    (sheet.landscape ? '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '') +
    '</worksheet>'
  );
}

/**
 * Nombres de hoja que Excel acepta: sin []:*?/\ ni apóstrofos en los extremos, de 1 a 31 caracteres, distintos de
 * los reservados para el historial de cambios y únicos sin distinguir mayúsculas.
 */
function sheetNames(sheets: SheetSpec[]): string[] {
  /** Recorta a `max` unidades UTF-16 sin dejar un par sustituto a medias. */
  const cut = (s: string, max: number): string => s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
  const used = new Set<string>();
  return sheets.map((sheet, i) => {
    const valid = sheet.name.replace(INVALID_XML, '').replace(/[\t\n\r]/g, ' ').replace(/[[\]:*?/\\]/g, '_');
    const base = cut(valid, 31).replace(/^[ ']+|[ ']+$/g, '').replace(/^histor(y|ial)$/i, '$&_') || `Hoja ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${cut(base, 31 - ` (${n})`.length)} (${n})`;
    used.add(name.toLowerCase());
    return name;
  });
}

const relationships = (targets: [type: string, target: string][]): string =>
  `${XML}<Relationships xmlns="${NS_PACKAGE}/relationships">` +
  targets.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${type}" Target="${target}"/>`).join('') +
  '</Relationships>';

/** Libro .xlsx completo, listo para descargar o guardar. */
export function buildXlsx(sheets: SheetSpec[], opts: WorkbookOptions = {}): Uint8Array {
  const specs = sheets.length ? sheets : [{ name: '', rows: [] }]; // un libro sin hojas no es válido
  const names = sheetNames(specs);
  const styles = createStyles();
  const sheetParts = specs.map((sheet, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, styles.id, i === 0)]);
  const date = opts.date && !Number.isNaN(opts.date.getTime()) ? opts.date : new Date();
  const stamp = `${date.toISOString().slice(0, 19)}Z`;
  const printTitles = specs
    .map((sheet, i) => {
      const n = whole(sheet.printTitleRows, MAX_ROWS);
      return n ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${text(`'${names[i].replace(/'/g, "''")}'!$1:$${n}`)}</definedName>` : '';
    })
    .join('');

  const parts: [name: string, xml: string][] = [
    [
      '[Content_Types].xml',
      `${XML}<Types xmlns="${NS_PACKAGE}/content-types">` +
        `<Default Extension="rels" ContentType="${MIME_PACKAGE}.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="${MIME_OFFICE}.spreadsheetml.sheet.main+xml"/>` +
        sheetParts.map(([name]) => `<Override PartName="/${name}" ContentType="${MIME_OFFICE}.spreadsheetml.worksheet+xml"/>`).join('') +
        `<Override PartName="/xl/styles.xml" ContentType="${MIME_OFFICE}.spreadsheetml.styles+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="${MIME_PACKAGE}.core-properties+xml"/>` +
        `<Override PartName="/docProps/app.xml" ContentType="${MIME_OFFICE}.extended-properties+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      relationships([
        [`${NS_OFFICE}/relationships/officeDocument`, 'xl/workbook.xml'],
        [`${NS_PACKAGE}/relationships/metadata/core-properties`, 'docProps/core.xml'],
        [`${NS_OFFICE}/relationships/extended-properties`, 'docProps/app.xml'],
      ]),
    ],
    [
      'docProps/core.xml',
      `${XML}<cp:coreProperties xmlns:cp="${NS_PACKAGE}/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"` +
        ' xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        (opts.title ? `<dc:title>${text(opts.title)}</dc:title>` : '') +
        (opts.creator ? `<dc:creator>${text(opts.creator)}</dc:creator><cp:lastModifiedBy>${text(opts.creator)}</cp:lastModifiedBy>` : '') +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`,
    ],
    ['docProps/app.xml', `${XML}<Properties xmlns="${NS_OFFICE}/extended-properties"><Application>Metrado Lab</Application></Properties>`],
    [
      'xl/workbook.xml',
      `${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_OFFICE}/relationships"><bookViews><workbookView/></bookViews>` +
        `<sheets>${names.map((name, i) => `<sheet name="${attr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        (printTitles ? `<definedNames>${printTitles}</definedNames>` : '') +
        '<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      relationships([
        ...sheetParts.map(([name]): [string, string] => [`${NS_OFFICE}/relationships/worksheet`, name.slice(3)]),
        [`${NS_OFFICE}/relationships/styles`, 'styles.xml'],
      ]),
    ],
    ['xl/styles.xml', styles.xml()],
    ...sheetParts,
  ];
  const encoder = new TextEncoder();
  return zipStore(parts.map(([name, xml]) => ({ name, data: encoder.encode(xml) })), { date });
}
