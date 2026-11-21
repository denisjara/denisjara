import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32, deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32, readZip, zipBlob, zipStore } from '../src/io/zip';

const enc = new TextEncoder();
const tmp = mkdtempSync(join(tmpdir(), 'metrado-zip-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Fecha de las entradas en hora local, que es como la guarda el formato. */
const DATE = new Date(2026, 10, 15, 13, 45, 58);

/** Bytes pseudoaleatorios reproducibles. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 16;
  }
  return out;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

const SAMPLE = [
  { name: 'proyecto.json', data: enc.encode('{"nombre":"Edificio Ñandú","láminas":3}') },
  { name: 'planos/Cimentación — ñandú 🏗.pdf', data: noise(5000) },
  { name: '日本語/図面.dxf', data: Uint8Array.from({ length: 256 }, (_, i) => i) },
  { name: 'vacío.txt', data: new Uint8Array(0) },
];

/** python3 con el guion dado; null si no hay python3 en esta máquina. */
function python(script: string, args: string[] = []): Buffer | null {
  try {
    execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'pipe' });
  } catch {
    return null;
  }
  return execFileSync('python3', ['-c', script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

interface RawEntry {
  /** Como bytes, para probar nombres que no están en UTF-8. */
  name: string | Uint8Array;
  data: Uint8Array;
  /** 0 (por defecto) guarda tal cual; 8 comprime de verdad con zlib; cualquier otro solo se anota. */
  method?: number;
  flags?: number;
  /** Bit 3: CRC y tamaños a cero en la cabecera local y descriptor de datos detrás. */
  descriptor?: boolean;
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
}

/**
 * Ensamblador de pruebas, independiente del código probado, para imitar archivos «de otros programas»: DEFLATE,
 * descriptor de datos, campos extra distintos en la cabecera local y en el directorio, comentario final…
 */
function rawZip(entries: RawEntry[], comment: Uint8Array = new Uint8Array(0)): Buffer {
  const body: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(typeof e.name === 'string' ? enc.encode(e.name) : e.name);
    const method = e.method ?? 0;
    const packed = method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data);
    const flags = (e.flags ?? 0) | (e.descriptor ? 8 : 0);
    const sizes = Buffer.concat([u32(nodeCrc32(e.data)), u32(packed.length), u32(e.data.length)]);
    const fields = (extra: Uint8Array, real: boolean): Buffer =>
      Buffer.concat([u16(20), u16(flags), u16(method), u16(0x6dbd), u16(0x5d6f), real ? sizes : Buffer.alloc(12), u16(name.length), u16(extra.length)]);
    const localExtra = e.localExtra ?? new Uint8Array(0);
    const centralExtra = e.centralExtra ?? new Uint8Array(0);
    const local = Buffer.concat([u32(0x04034b50), fields(localExtra, !e.descriptor), name, localExtra, packed, e.descriptor ? Buffer.concat([u32(0x08074b50), sizes]) : Buffer.alloc(0)]);
    directory.push(Buffer.concat([u32(0x02014b50), u16(0x031e), fields(centralExtra, true), Buffer.alloc(10), u32(offset), name, centralExtra]));
    body.push(local);
    offset += local.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(dir.length), u32(offset), u16(comment.length), comment]);
  return Buffer.concat([...body, dir, end]);
}

/** Posición de la n-ésima firma (0 = primera) dentro del archivo. */
function find(zip: Uint8Array, signature: number, nth = 0): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let p = 0, seen = 0; p + 4 <= zip.length; p++) {
    if (view.getUint32(p, true) === signature && seen++ === nth) return p;
  }
  throw new Error('firma no encontrada');
}
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

async function readAll(file: Blob | Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const out = [];
  for (const entry of await readZip(file)) {
    const data = await entry.read();
    expect(data.length).toBe(entry.size);
    out.push({ name: entry.name, data });
  }
  return out;
}

describe('crc32', () => {
  it('vectores conocidos', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(new Uint8Array(32))).toBe(0x190a55ad);
    expect(crc32(new Uint8Array(32).fill(0xff))).toBe(0xff6cab0b);
  });
  it('coincide con zlib en datos arbitrarios', () => {
    for (const length of [1, 2, 3, 255, 256, 4097, 100003]) {
      const data = noise(length, length);
      expect(crc32(data)).toBe(nodeCrc32(data));
    }
  });
  it('se puede encadenar por trozos con `seed`', () => {
    const data = noise(10000, 7);
    for (const cut of [0, 1, 4999, 9999, 10000]) {
      expect(crc32(data.subarray(cut), crc32(data.subarray(0, cut)))).toBe(crc32(data));
    }
    expect(crc32(new Uint8Array(0), 0xdeadbeef)).toBe(0xdeadbeef);
  });
});

describe('zipStore y readZip', () => {
  it('ida y vuelta con nombres Unicode y archivos vacíos', async () => {
    const zip = zipStore(SAMPLE, { date: DATE });
    for (const source of [zip, new Blob([zip])]) {
      const entries = await readAll(source);
      expect(entries.map((e) => e.name)).toEqual(SAMPLE.map((e) => e.name));
      entries.forEach((e, i) => expect(same(e.data, SAMPLE[i].data)).toBe(true));
    }
  });

  it('un archivo sin entradas es válido', async () => {
    const zip = zipStore([]);
    expect(zip.length).toBe(22);
    expect(await readZip(zip)).toEqual([]);
  });

  it('escribe la cabecera como se espera: STORE, versión 2.0, fecha DOS y bit 11 solo en nombres no ASCII', () => {
    const zip = zipStore(SAMPLE, { date: DATE });
    const view = new DataView(zip.buffer);
    const expectedTime = (13 << 11) | (45 << 5) | 29;
    const expectedDate = ((2026 - 1980) << 9) | (11 << 5) | 15;
    SAMPLE.forEach((entry, i) => {
      const p = find(zip, CENTRAL, i);
      expect(view.getUint16(p + 6, true)).toBe(20); // versión necesaria
      expect(view.getUint16(p + 8, true)).toBe(/^[\x00-\x7f]*$/.test(entry.name) ? 0 : 0x0800);
      expect(view.getUint16(p + 10, true)).toBe(0); // método STORE
      expect(view.getUint16(p + 12, true)).toBe(expectedTime);
      expect(view.getUint16(p + 14, true)).toBe(expectedDate);
      expect(view.getUint32(p + 16, true)).toBe(nodeCrc32(entry.data));
      expect(view.getUint32(p + 20, true)).toBe(entry.data.length);
      expect(view.getUint32(p + 24, true)).toBe(entry.data.length);
      // La cabecera local repite los mismos campos.
      const local = view.getUint32(p + 42, true);
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      expect(same(zip.subarray(local + 4, local + 30), zip.subarray(p + 6, p + 32))).toBe(true);
    });
  });

  it('con la misma fecha la salida es idéntica; las fechas fuera del rango DOS se guardan como 1980-01-01', () => {
    expect(same(zipStore(SAMPLE, { date: DATE }), zipStore(SAMPLE, { date: new Date(DATE) }))).toBe(true);
    for (const date of [new Date(1970, 0, 1), new Date(NaN)]) {
      const zip = zipStore([{ name: 'a', data: new Uint8Array(1) }], { date });
      const view = new DataView(zip.buffer);
      expect([view.getUint16(10, true), view.getUint16(12, true)]).toEqual([0, 0x21]);
    }
  });

  it('acepta un Buffer de Node con desplazamiento y devuelve siempre copias propias', async () => {
    const zip = zipStore(SAMPLE, { date: DATE });
    const shifted = Buffer.concat([Buffer.alloc(13, 0xaa), zip]).subarray(13);
    expect(shifted.byteOffset).toBeGreaterThan(0);
    const [first] = await readZip(shifted);
    const a = await first.read();
    expect(a.buffer).not.toBe(shifted.buffer);
    a.fill(0);
    expect(same(await first.read(), SAMPLE[0].data)).toBe(true);
    expect(same(shifted, zip)).toBe(true);
  });

  it('rechaza crear archivos que no caben sin ZIP64 o con nombres no válidos', async () => {
    const empty = new Uint8Array(0);
    const many = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: empty }));
    expect(() => zipStore(many)).toThrow(/65 535 archivos/);
    expect(await readZip(zipStore(many.slice(1)))).toHaveLength(65535);

    const blob = (size: number): Blob => ({ size }) as Blob; // no llega a leerse: los límites se comprueban antes
    await expect(zipBlob([{ name: 'enorme.pdf', data: blob(2 ** 32) }])).rejects.toThrow(/4 GiB/);
    await expect(zipBlob(['a', 'b', 'c'].map((name) => ({ name, data: blob(1.5 * 2 ** 30) })))).rejects.toThrow(/4 GiB/);

    for (const name of ['', '../fuera.txt', 'a/../../b', '/abs', '\\abs', 'C:\\x', 'x'.repeat(65536)]) {
      expect(() => zipStore([{ name, data: empty }])).toThrow(/nombre de archivo no válido/);
    }
  });
});

describe('zipBlob', () => {
  it('con Blobs produce byte a byte lo mismo que zipStore y lee los Blob por trozos', async () => {
    const big = noise(9 * 2 ** 20 + 123, 3);
    const entries = [...SAMPLE, { name: 'planos/grande.pdf', data: big }];
    const expected = zipStore(entries, { date: DATE });

    const slices: number[] = [];
    class SpyBlob extends Blob {
      override slice(start = 0, end = this.size, type?: string): Blob {
        slices.push(end - start);
        return super.slice(start, end, type);
      }
    }
    const blob = await zipBlob([...SAMPLE.map((e) => ({ name: e.name, data: new Blob([e.data]) })), { name: 'planos/grande.pdf', data: new SpyBlob([big]) }], 'application/x-metrado', { date: DATE });
    expect(blob.type).toBe('application/x-metrado');
    expect(same(new Uint8Array(await blob.arrayBuffer()), expected)).toBe(true);
    expect(slices).toEqual([4 << 20, 4 << 20, 4 << 20]); // el último trozo pedido sobrepasa el final y el Blob lo recorta

    const mixed = await zipBlob(entries.map((e, i) => ({ name: e.name, data: i % 2 ? new Blob([e.data]) : e.data })), undefined, { date: DATE });
    expect(mixed.type).toBe('application/zip');
    expect(same(new Uint8Array(await mixed.arrayBuffer()), expected)).toBe(true);

    const back = await readAll(blob);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(same(back[4].data, big)).toBe(true);
  });
});

describe('compatibilidad con otros programas', () => {
  it('Python (zipfile) lee lo que escribimos', (ctx) => {
    const path = join(tmp, 'nuestro.zip');
    writeFileSync(path, zipStore(SAMPLE, { date: DATE }));
    const out = python(
      `
import base64, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'bad': z.testzip(), 'entries': [{
        'name': i.filename, 'size': i.file_size, 'date': list(i.date_time), 'method': i.compress_type,
        'data': base64.b64encode(z.read(i)).decode()} for i in z.infolist()]}))
`,
      [path],
    );
    if (!out) return ctx.skip('python3 no está disponible: no se comprobó la lectura con zipfile');
    const listing = JSON.parse(out.toString()) as { bad: string | null; entries: { name: string; size: number; date: number[]; method: number; data: string }[] };
    expect(listing.bad).toBeNull(); // todos los CRC son correctos
    expect(listing.entries.map((e) => e.name)).toEqual(SAMPLE.map((e) => e.name));
    listing.entries.forEach((e, i) => {
      expect(e.size).toBe(SAMPLE[i].data.length);
      expect(e.method).toBe(0);
      expect(e.date).toEqual([2026, 11, 15, 13, 45, 58]);
      expect(same(Buffer.from(e.data, 'base64'), SAMPLE[i].data)).toBe(true);
    });
  });

  // Los mismos datos que generan los guiones de Python de abajo.
  const text = enc.encode(Array.from({ length: 3000 }, (_, i) => `Partida ${i}: concreto f'c=210 kg/cm² — ñandú\n`).join(''));
  const binary = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7 + (i >> 8)) & 255);
  const pythonData = `
import sys, zipfile
text = ''.join("Partida %d: concreto f'c=210 kg/cm² — ñandú\\n" % i for i in range(3000)).encode()
binary = bytes((i * 7 + (i >> 8)) & 255 for i in range(70000))
`;

  it('lee un ZIP comprimido (DEFLATE) creado por Python, con comentario, carpeta y campo extra', async (ctx) => {
    const path = join(tmp, 'python.zip');
    const out = python(
      `${pythonData}
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.comment = 'Creado con Python — ñ'.encode()
    z.writestr('texto.txt', text)
    z.writestr('carpeta/', b'')
    z.writestr('carpeta/ñandú — plano.bin', binary)
    z.writestr('vacío.txt', b'')
    z.writestr(zipfile.ZipInfo('sin comprimir.bin'), binary[:1000])
    info = zipfile.ZipInfo('con extra.txt')
    info.compress_type = zipfile.ZIP_DEFLATED
    info.extra = b'\\xfe\\xca\\x04\\x00meta'
    z.writestr(info, text[:500])
`,
      [path],
    );
    if (!out) return ctx.skip('python3 no está disponible: no se comprobó la lectura de un ZIP de Python');
    const file = readFileSync(path);
    expect(file.length).toBeLessThan(text.length); // está comprimido de verdad
    for (const source of [file, new Blob([file])]) {
      const entries = await readAll(source);
      expect(entries.map((e) => e.name)).toEqual(['texto.txt', 'carpeta/ñandú — plano.bin', 'vacío.txt', 'sin comprimir.bin', 'con extra.txt']);
      expect(same(entries[0].data, text)).toBe(true);
      expect(same(entries[1].data, binary)).toBe(true);
      expect(entries[2].data.length).toBe(0);
      expect(same(entries[3].data, binary.subarray(0, 1000))).toBe(true);
      expect(same(entries[4].data, text.subarray(0, 500))).toBe(true);
    }
  });

  it('lee un ZIP que Python escribe en una tubería: entradas con descriptor de datos (bit 3)', async (ctx) => {
    const out = python(`${pythonData}
with zipfile.ZipFile(sys.stdout.buffer, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('texto.txt', text)
    z.writestr('binario.bin', binary)
`);
    if (!out) return ctx.skip('python3 no está disponible: no se comprobó la lectura de un ZIP escrito en una tubería');
    expect(out.readUInt16LE(6) & 8).toBe(8); // la cabecera local no trae CRC ni tamaños
    expect(out.readUInt32LE(14)).toBe(0);
    const entries = await readAll(out);
    expect(entries.map((e) => e.name)).toEqual(['texto.txt', 'binario.bin']);
    expect(same(entries[0].data, text)).toBe(true);
    expect(same(entries[1].data, binary)).toBe(true);
  });

  it('DEFLATE, descriptor de datos, campos extra distintos y comentario (archivo armado a mano)', async () => {
    const entries: RawEntry[] = [
      { name: 'a.txt', data: enc.encode('hola '.repeat(2000)), method: 8, descriptor: true, localExtra: noise(9), centralExtra: noise(5) },
      { name: 'dir/', data: new Uint8Array(0) },
      { name: 'dir/b.bin', data: noise(3000), localExtra: noise(28) },
      { name: 'dir/c.bin', data: noise(3000, 9), method: 8, flags: 0x0800 },
      { name: 'vacío comprimido', data: new Uint8Array(0), method: 8 },
    ];
    const comment = enc.encode('comentario final — con ñ. '.repeat(20));
    const zip = rawZip(entries, comment);
    const files = entries.filter((e) => e.name !== 'dir/');
    for (const source of [zip, new Blob([zip])]) {
      const read = await readAll(source);
      expect(read.map((e) => e.name)).toEqual(files.map((e) => e.name));
      read.forEach((e, i) => expect(same(e.data, files[i].data)).toBe(true));
    }
  });

  it('encuentra el directorio tras un comentario del tamaño máximo y tolera bytes sobrantes al final', async () => {
    const entry = { name: 'plano.pdf', data: noise(2000) };
    const full = rawZip([entry], new Uint8Array(65535).fill(0x2d));
    expect(same((await readAll(new Blob([full])))[0].data, entry.data)).toBe(true);
    const trailing = Buffer.concat([rawZip([entry]), Buffer.alloc(300, 0x20)]);
    expect(same((await readAll(trailing))[0].data, entry.data)).toBe(true);
  });

  it('nombres sin el bit 11: UTF-8 si lo son (macOS) y, si no, CP850 (Windows en español)', async () => {
    const cp850 = Uint8Array.from([...'CIMENTACI'].map((c) => c.charCodeAt(0)).concat([0xe0, 0x4e, 0x20, 0xa4, 0xa5, 0x2e, 0x70, 0x64, 0x66]));
    const zip = rawZip([
      { name: 'Cimentación ñ.pdf', data: noise(10) },
      { name: cp850, data: noise(10) },
    ]);
    expect((await readZip(zip)).map((e) => e.name)).toEqual(['Cimentación ñ.pdf', 'CIMENTACIÓN ñÑ.pdf']);
  });
});

describe('archivos dañados, truncados o peligrosos', () => {
  const entries: RawEntry[] = [
    { name: 'uno.txt', data: enc.encode('contenido del primero') },
    { name: 'dos.txt', data: enc.encode('contenido del segundo, comprimido '.repeat(4)), method: 8 },
  ];
  const good = rawZip(entries, enc.encode('fin'));

  it('detecta un byte cambiado en los datos y un CRC cambiado en el directorio', async () => {
    const stored = zipStore(SAMPLE, { date: DATE });
    const flipped = stored.slice();
    flipped[30 + SAMPLE[0].name.length + 3] ^= 0x01;
    const [first, second] = await readZip(flipped);
    await expect(first.read()).rejects.toThrow(/Archivo ZIP dañado: «proyecto\.json» no supera la comprobación de tamaño y CRC/);
    expect(same(await second.read(), SAMPLE[1].data)).toBe(true); // las demás entradas siguen siendo legibles

    const crc = Buffer.from(good);
    crc[find(crc, CENTRAL, 1) + 16] ^= 0x80;
    const [uno, dos] = await readZip(crc);
    expect(same(await uno.read(), entries[0].data)).toBe(true);
    await expect(dos.read()).rejects.toThrow(/Archivo ZIP dañado: «dos\.txt»/);
  });

  it('no se fía de los tamaños declarados', async () => {
    const central = [find(good, CENTRAL, 0), find(good, CENTRAL, 1)];
    const patched = (at: number, value: number): Buffer => {
      const copy = Buffer.from(good);
      copy.writeUInt32LE(value, at);
      return copy;
    };
    // Tamaño real mayor o menor que el declarado, en la entrada guardada (0) y en la comprimida (1).
    for (const [index, size] of [[0, 5], [0, 500], [1, 5], [1, 0x7fffffff]]) {
      const list = await readZip(patched(central[index] + 24, size));
      expect(list[index].size).toBe(size);
      await expect(list[index].read()).rejects.toThrow(/^Archivo ZIP dañado: «(uno|dos)\.txt» no supera la comprobación de tamaño y CRC/);
    }
    // Datos que se salen del archivo: tamaño comprimido enorme, o cabecera local más allá del directorio.
    await expect((await readZip(patched(central[0] + 20, 0x7fffffff)))[0].read()).rejects.toThrow(/Archivo ZIP dañado: «uno\.txt» queda fuera del archivo/);
    await expect((await readZip(patched(central[1] + 42, 0x7fffffff)))[1].read()).rejects.toThrow(/Archivo ZIP dañado: «dos\.txt» queda fuera del archivo/);
    // Directorio central fuera del archivo.
    await expect(readZip(patched(find(good, END) + 16, 0x7fffffff))).rejects.toThrow(/Archivo ZIP dañado: el directorio central no cabe/);
    await expect(readZip(patched(find(good, END) + 12, 0x7fffffff))).rejects.toThrow(/Archivo ZIP dañado: el directorio central no cabe/);
  });

  it('rechaza cualquier archivo truncado y lo que no es un ZIP', async () => {
    for (let length = 0; length < good.length; length++) {
      await expect(readZip(good.subarray(0, length)), `primeros ${length} bytes`).rejects.toThrow(/^Archivo ZIP dañado/);
    }
    for (const start of [1, 30, 100]) await expect(readZip(good.subarray(start))).rejects.toThrow(/^Archivo ZIP dañado/);
    await expect(readZip(new Blob([good.subarray(0, good.length - 1)]))).rejects.toThrow(/^Archivo ZIP dañado/);
    await expect(readZip(noise(5000))).rejects.toThrow(/^Archivo ZIP dañado: no se encuentra el directorio central/);
    await expect(readZip(new Blob([]))).rejects.toThrow(/^Archivo ZIP dañado/);
  });

  it('cualquier byte alterado da un error en español o los datos correctos, nunca otra cosa', async () => {
    const originals = entries.map((e) => Buffer.from(e.data).toString('latin1'));
    /** El resultado de `run`, o undefined si falla con uno de los errores previstos. */
    const attempt = async <T>(where: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        expect((error as Error).message, where).toMatch(/^Archivo ZIP (dañado|no admitido|no seguro): /);
        return undefined;
      }
    };
    let failures = 0;
    for (const mask of [0xff, 0x01, 0x80]) {
      for (let i = 0; i < good.length; i++) {
        const where = `byte ${i} ^ 0x${mask.toString(16)}`;
        const zip = Buffer.from(good);
        zip[i] ^= mask;
        const list = await attempt(where, () => readZip(zip));
        for (const entry of list ?? []) {
          const data = await attempt(where, () => entry.read());
          if (data) expect(originals, where).toContain(Buffer.from(data).toString('latin1'));
          else failures++;
        }
        if (!list) failures++;
      }
    }
    expect(failures).toBeGreaterThan(good.length); // la mayoría de las alteraciones se detectan
  });

  it('rechaza el archivo entero si alguna ruta es absoluta o sube con «..»', async () => {
    for (const name of ['../fuera.txt', 'a/../../b.txt', 'a\\..\\b.txt', '/etc/passwd', '\\servidor\\x', 'C:\\Windows\\x.dll', 'c:/x', 'carpeta/../']) {
      const zip = rawZip([{ name: 'bueno.txt', data: noise(5) }, { name, data: noise(5) }]);
      await expect(readZip(zip), name).rejects.toThrow(/^Archivo ZIP no seguro: la ruta «.*» es absoluta o sube de carpeta/);
    }
    // Los puntos que no forman un segmento «..» y las unidades sin barra son nombres corrientes.
    const fine = ['..oculto', 'a..b/c', '...', 'a/b..', 'C:plano.pdf', 'a/.b/c.'];
    expect((await readZip(rawZip(fine.map((name) => ({ name, data: noise(5) }))))).map((e) => e.name)).toEqual(fine);
  });

  it('lo que no admite lo dice: cifrado, otros métodos de compresión, ZIP64 y varios volúmenes', async () => {
    const zip = rawZip([
      { name: 'cifrado.bin', data: noise(20), flags: 1 },
      { name: 'bzip2.bin', data: noise(20), method: 12 },
      { name: 'normal.bin', data: noise(20) },
    ]);
    const [encrypted, bzip2, normal] = await readZip(zip);
    await expect(encrypted.read()).rejects.toThrow(/^Archivo ZIP no admitido: «cifrado\.bin» está cifrado/);
    await expect(bzip2.read()).rejects.toThrow(/^Archivo ZIP no admitido: «bzip2\.bin» usa el método de compresión 12/);
    expect(same(await normal.read(), noise(20))).toBe(true);

    // ZIP64: campos saturados en el registro final y, justo antes, el localizador del registro ZIP64.
    const end = find(zip, END);
    const zip64 = Buffer.concat([zip.subarray(0, end), u32(0x07064b50), Buffer.alloc(16), zip.subarray(end)]);
    zip64.writeUInt16LE(0xffff, end + 20 + 10);
    await expect(readZip(zip64)).rejects.toThrow(/^Archivo ZIP no admitido: usa el formato ZIP64/);
    const entry64 = Buffer.from(zip);
    entry64.writeUInt32LE(0xffffffff, find(zip, CENTRAL, 2) + 20);
    await expect(readZip(entry64)).rejects.toThrow(/^Archivo ZIP no admitido: usa el formato ZIP64/);

    const spanned = Buffer.from(zip);
    spanned.writeUInt16LE(1, end + 4);
    await expect(readZip(spanned)).rejects.toThrow(/^Archivo ZIP no admitido: está repartido en varios volúmenes/);
  });
});
