/**
 * Archivos ZIP sin dependencias: escritura sin compresión (STORE) y lectura de entradas STORE y DEFLATE.
 *
 * Lo usan el exportador de Excel (un .xlsx es un ZIP de XML) y el archivo de proyecto, que guarda los planos tal
 * cual: un PDF ya viene comprimido, así que STORE no desperdicia espacio y permite armar el archivo como un Blob
 * hecho de piezas, sin copiar el plano en memoria.
 *
 * Alcance: un solo volumen, sin cifrado y sin ZIP64 (hasta 4 GiB y 65 535 entradas).
 *
 * Nombres: se escriben en UTF-8, con el bit 11 («nombre en UTF-8») solo cuando llevan algún carácter no ASCII, que
 * es cuando importa; así las partes de un .xlsx salen sin indicadores, como pide el empaquetado de Office. Ni al
 * escribir ni al leer se aceptan rutas absolutas o con segmentos «..»: `readZip` rechaza el archivo entero en vez de
 * saltarse la entrada, porque es preferible un error claro a un proyecto abierto a medias.
 */

const LOCAL = 0x04034b50; // cabecera local de una entrada
const CENTRAL = 0x02014b50; // entrada del directorio central
const END = 0x06054b50; // registro de fin del directorio central
const ZIP64_LOCATOR = 0x07064b50;
const END_SIZE = 22;
/** Trozo con el que se recorre un Blob para calcular su CRC sin cargarlo entero. */
const CRC_CHUNK = 4 << 20;

/**
 * Mitad alta (0x80–0xFF) de la página de códigos 850, la «OEM» de Windows en español, con la que los compresores
 * antiguos guardan los nombres. Coincide con la CP437 del estándar ZIP en las minúsculas acentuadas, la ñ y la Ñ, y
 * además trae Á, Í, Ó y Ú.
 */
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';

const utf8Encoder = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** CRC-32 (IEEE 802.3, el de ZIP y PNG). `seed` es el CRC de los bytes anteriores, para calcularlo por trozos. */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipInput {
  name: string;
  data: Uint8Array | Blob;
}

export interface ZipWriteOptions {
  /** Fecha de modificación de todas las entradas (por defecto, ahora). Con una fecha fija la salida es reproducible. */
  date?: Date;
}

export interface ZipEntry {
  name: string;
  /** Tamaño sin comprimir, en bytes. */
  size: number;
  /** Bytes de la entrada (una copia propia en cada llamada), con el tamaño y el CRC ya comprobados. */
  read(): Promise<Uint8Array>;
}

/** Lo que las cabeceras necesitan saber de una entrada; el CRC lo rellena quien escribe. */
interface Slot {
  name: Uint8Array;
  size: number;
  offset: number;
  crc: number;
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

const damaged = (why: string): Error => new Error(`Archivo ZIP dañado: ${why}`);

const unsupported = (what: string): Error => new Error(`Archivo ZIP no admitido: ${what}`);

/** Ruta absoluta (`/x`, `\x`, `C:\x`) o con algún segmento `..`: al extraerla podría salirse de su carpeta. */
const unsafeName = (name: string): boolean => /^(?:[\\/]|[a-z]:[\\/])/i.test(name) || name.split(/[\\/]/).includes('..');

/** Fecha y hora en formato MS-DOS: hora local (el formato no lleva zona), resolución de 2 s, años 1980 a 2107. */
function dosDateTime(d: Date): [time: number, date: number] {
  const year = Math.min(d.getFullYear(), 2107);
  if (!(year >= 1980)) return [0, 0x21]; // fecha anterior o no válida: 1980-01-01 00:00:00
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

/** Valida nombres y límites (no hay ZIP64) y fija dónde empieza cada entrada, sin leer todavía ningún dato. */
function plan(entries: ZipInput[]): Slot[] {
  if (entries.length > 0xffff) throw new Error('No se puede crear el ZIP: admite como máximo 65 535 archivos');
  let offset = 0;
  let total = END_SIZE;
  const slots = entries.map(({ name, data }) => {
    const bytes = utf8Encoder.encode(name);
    if (!bytes.length || bytes.length > 0xffff || unsafeName(name)) {
      throw new Error(`No se puede crear el ZIP: nombre de archivo no válido «${name}»`);
    }
    const slot: Slot = { name: bytes, size: data instanceof Uint8Array ? data.length : data.size, offset, crc: 0 };
    offset += 30 + bytes.length + slot.size;
    total += 30 + 46 + 2 * bytes.length + slot.size;
    return slot;
  });
  if (total > 2 ** 32) throw new Error('No se puede crear el ZIP: superaría los 4 GiB (no se admite ZIP64)');
  return slots;
}

/** Archivo completo por piezas: cabecera local y datos de cada entrada y, al final, directorio central y cierre. */
function assemble<T>(slots: Slot[], payloads: T[], date = new Date()): (Uint8Array | T)[] {
  const [time, day] = dosDateTime(date);
  let dirOffset = 0;
  const locals = slots.map((s) => {
    const b = new Uint8Array(30 + s.name.length);
    const v = view(b);
    v.setUint32(0, LOCAL, true);
    v.setUint16(4, 20, true); // versión necesaria para extraer: 2.0
    v.setUint16(6, s.name.some((c) => c > 0x7f) ? 0x0800 : 0, true); // bit 11: nombre en UTF-8
    v.setUint16(10, time, true); // (bytes 8-9: método 0, STORE)
    v.setUint16(12, day, true);
    v.setUint32(14, s.crc, true);
    v.setUint32(18, s.size, true); // tamaño comprimido = tamaño real
    v.setUint32(22, s.size, true);
    v.setUint16(26, s.name.length, true);
    b.set(s.name, 30);
    dirOffset = s.offset + b.length + s.size;
    return b;
  });
  const dirSize = slots.reduce((n, s) => n + 46 + s.name.length, 0);
  const end = new Uint8Array(dirSize + END_SIZE);
  const v = view(end);
  let p = 0;
  slots.forEach((s, i) => {
    v.setUint32(p, CENTRAL, true);
    v.setUint16(p + 4, 20, true); // creado con la versión 2.0 en «MS-DOS»: sin permisos Unix que aplicar
    end.set(locals[i].subarray(4, 30), p + 6); // los mismos campos que la cabecera local
    v.setUint32(p + 42, s.offset, true);
    end.set(s.name, p + 46);
    p += 46 + s.name.length;
  });
  v.setUint32(p, END, true);
  v.setUint16(p + 8, slots.length, true);
  v.setUint16(p + 10, slots.length, true);
  v.setUint32(p + 12, dirSize, true);
  v.setUint32(p + 16, dirOffset, true);
  return [...payloads.flatMap((data, i) => [locals[i], data]), end];
}

/** Archivo ZIP sin compresión, síncrono, a partir de datos en memoria. Es el contenedor de los .xlsx. */
export function zipStore(entries: { name: string; data: Uint8Array }[], opts: ZipWriteOptions = {}): Uint8Array {
  const slots = plan(entries);
  slots.forEach((s, i) => (s.crc = crc32(entries[i].data)));
  const parts = assemble(slots, entries.map((e) => e.data), opts.date);
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/**
 * Archivo ZIP sin compresión como Blob hecho de piezas: los Blob de entrada se referencian, no se copian (un PDF de
 * 150 MB no se duplica en memoria); su CRC se calcula leyéndolos por trozos.
 */
export async function zipBlob(entries: ZipInput[], mimeType = 'application/zip', opts: ZipWriteOptions = {}): Promise<Blob> {
  const slots = plan(entries);
  for (const [i, { data }] of entries.entries()) {
    if (data instanceof Uint8Array) slots[i].crc = crc32(data);
    else {
      for (let p = 0; p < data.size; p += CRC_CHUNK) {
        slots[i].crc = crc32(new Uint8Array(await data.slice(p, p + CRC_CHUNK).arrayBuffer()), slots[i].crc);
      }
    }
  }
  return new Blob(assemble(slots, entries.map((e) => e.data), opts.date), { type: mimeType });
}

/** Nombre de una entrada: UTF-8 si los bytes lo son (lo anuncie o no el bit 11; macOS no lo pone) y, si no, CP850. */
function decodeName(bytes: Uint8Array): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : CP850[b - 0x80])).join('');
  }
}

/**
 * Descomprime DEFLATE en crudo sin fiarse del tamaño declarado: si los datos están corruptos o dan más bytes de los
 * anunciados se corta ahí, y ese resultado incompleto no superará después la comprobación de tamaño y CRC.
 */
async function inflateRaw(raw: Uint8Array, size: number): Promise<Uint8Array> {
  // DEFLATE no expande más de 1032 a 1: un tamaño declarado mayor es falso y no merece reservar memoria.
  const out = new Uint8Array(Math.min(size, raw.length * 1032));
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let n = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      out.set(chunk.value, n); // RangeError si ya no cabe
      n += chunk.value.length;
    }
  } catch {
    void reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, n);
}

/**
 * Lee el directorio de un archivo ZIP y devuelve sus archivos (las carpetas se omiten); los datos de cada uno solo se
 * leen al llamar a `read()`. Entiende los archivos de otros programas: comentario final, campos extra y entradas con
 * descriptor de datos (bit 3), cuyos tamaños y CRC se toman del directorio central.
 *
 * Lanza un error en español si el archivo está dañado o truncado, usa algo no admitido (ZIP64, varios volúmenes) o
 * trae alguna ruta absoluta o con «..». El cifrado y los métodos de compresión distintos de STORE y DEFLATE se
 * rechazan al leer la entrada afectada.
 */
export async function readZip(file: Blob | Uint8Array): Promise<ZipEntry[]> {
  const total = file instanceof Uint8Array ? file.length : file.size;
  /** Copia de los bytes [start, end) del archivo. */
  const bytes = async (start: number, end: number): Promise<Uint8Array> =>
    new Uint8Array(file instanceof Uint8Array ? file.subarray(start, end) : await file.slice(start, end).arrayBuffer());

  // El registro de fin está al final del archivo, seguido como mucho por un comentario de 65 535 bytes.
  const tailStart = Math.max(0, total - END_SIZE - 0xffff);
  const tail = view(await bytes(tailStart, total));
  let p = tail.byteLength - END_SIZE;
  while (p >= 0 && (tail.getUint32(p, true) !== END || p + END_SIZE + tail.getUint16(p + 20, true) > tail.byteLength)) p--;
  if (p < 0) throw damaged('no se encuentra el directorio central (¿está truncado o no es un ZIP?)');
  const end = tailStart + p;
  const count = tail.getUint16(p + 10, true);
  const dirSize = tail.getUint32(p + 12, true);
  const dirOffset = tail.getUint32(p + 16, true);
  // Un campo saturado solo significa «mira el registro ZIP64» si ese registro existe (su localizador va justo antes).
  if ((count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) && end >= 20) {
    if (view(await bytes(end - 20, end)).getUint32(0, true) === ZIP64_LOCATOR) throw unsupported('usa el formato ZIP64');
  }
  if (tail.getUint16(p + 4, true) || tail.getUint16(p + 6, true) || tail.getUint16(p + 8, true) !== count) {
    throw unsupported('está repartido en varios volúmenes');
  }
  if (dirOffset + dirSize > end) throw damaged('el directorio central no cabe en el archivo');

  const dir = await bytes(dirOffset, dirOffset + dirSize);
  const dv = view(dir);
  const entries: ZipEntry[] = [];
  for (let i = 0, q = 0; i < count; i++) {
    if (q + 46 > dir.length || dv.getUint32(q, true) !== CENTRAL) throw damaged('directorio central ilegible');
    const flags = dv.getUint16(q + 8, true);
    const method = dv.getUint16(q + 10, true);
    const crc = dv.getUint32(q + 16, true);
    const packed = dv.getUint32(q + 20, true);
    const size = dv.getUint32(q + 24, true);
    const offset = dv.getUint32(q + 42, true);
    const nameEnd = q + 46 + dv.getUint16(q + 28, true);
    const next = nameEnd + dv.getUint16(q + 30, true) + dv.getUint16(q + 32, true); // tras el campo extra y el comentario
    if (next > dir.length) throw damaged('directorio central ilegible');
    const name = decodeName(dir.subarray(q + 46, nameEnd));
    q = next;
    if (unsafeName(name)) throw new Error(`Archivo ZIP no seguro: la ruta «${name}» es absoluta o sube de carpeta con «..»`);
    if (name.endsWith('/')) continue; // carpeta
    if (packed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw unsupported('usa el formato ZIP64');

    const read = async (): Promise<Uint8Array> => {
      if (flags & 1) throw unsupported(`«${name}» está cifrado`);
      if (method !== 0 && method !== 8) throw unsupported(`«${name}» usa el método de compresión ${method}`);
      // Los datos van tras la cabecera local, cuyo nombre y campo extra pueden medir distinto que en el directorio.
      if (offset + 30 > dirOffset) throw damaged(`«${name}» queda fuera del archivo`);
      const local = view(await bytes(offset, offset + 30));
      const start = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      if (local.getUint32(0, true) !== LOCAL || start + packed > dirOffset) throw damaged(`«${name}» queda fuera del archivo`);
      const raw = await bytes(start, start + packed);
      const data = method === 8 ? await inflateRaw(raw, size) : raw;
      if (data.length !== size || crc32(data) !== crc) throw damaged(`«${name}» no supera la comprobación de tamaño y CRC`);
      return data;
    };
    entries.push({ name, size, read });
  }
  return entries;
}
