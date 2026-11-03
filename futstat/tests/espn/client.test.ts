/**
 * Cliente HTTP endurecido: límite de tamaño (content-length y lectura en streaming), content-type JSON, JSON inválido
 * o con forma inesperada (error tipado), hosts permitidos, reintentos y cortacircuitos cuando ESPN no responde.
 * Sin red: se inyecta `fetchImpl`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CIRCUIT_THRESHOLD,
  CircuitOpenError,
  DeadlineError,
  HttpError,
  InvalidResponseError,
  fetchJson,
  isAllowedUrl,
  isCircuitOpen,
  isJsonContentType,
  resetCircuit,
  scoreboardUrl,
  setConcurrency,
  summaryUrl,
} from '../../pipeline/espn/client';

const URL_OK = 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=2026&limit=1000';

type FetchFn = typeof fetch;

function jsonResponse(body: string, headers: Record<string, string> = { 'content-type': 'application/json;charset=UTF-8' }, status = 200): Response {
  return new Response(body, { status, headers });
}

/** fetch falso que devuelve las respuestas en orden (la última se repite) y cuenta las llamadas. */
function fakeFetch(...responses: (() => Response | Promise<Response>)[]): FetchFn & { calls: number } {
  const f = (async () => {
    const r = responses[Math.min(f.calls, responses.length - 1)];
    f.calls++;
    return r();
  }) as unknown as FetchFn & { calls: number };
  f.calls = 0;
  return f;
}

/** Cuerpo en streaming de `chunks` trozos de `size` bytes (sin content-length). */
function streamingBody(chunks: number, size: number): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  const res = new Response(stream, { headers: { 'content-type': 'application/json' } });
  (res as unknown as { sent: () => number }).sent = () => sent;
  return res;
}

const fast = { backoffScale: 0, retries: 2 };

afterEach(() => resetCircuit());

describe('fetchJson · respuestas válidas', () => {
  it('parsea un objeto JSON', async () => {
    const f = fakeFetch(() => jsonResponse('{"events":[]}'));
    await expect(fetchJson(URL_OK, { fetchImpl: f, ...fast })).resolves.toEqual({ events: [] });
    expect(f.calls).toBe(1);
  });

  it('sin content-type se intenta parsear igualmente', async () => {
    // (un cuerpo binario no lleva content-type; uno de texto recibiría text/plain automáticamente)
    const f = fakeFetch(() => new Response(new TextEncoder().encode('{"a":1}')));
    await expect(fetchJson(URL_OK, { fetchImpl: f, ...fast })).resolves.toEqual({ a: 1 });
  });
});

describe('fetchJson · respuestas malas', () => {
  it('respuesta enorme declarada en content-length → error tipado sin leer el cuerpo ni reintentar', async () => {
    const f = fakeFetch(() => jsonResponse('{}', { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) }));
    const err = await fetchJson(URL_OK, { fetchImpl: f, ...fast }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
    expect((err as InvalidResponseError).reason).toBe('too-large');
    expect(f.calls).toBe(1);
  });

  it('respuesta enorme en streaming (sin content-length) → la lectura se corta al superar el límite', async () => {
    let res: Response | undefined;
    const f = fakeFetch(() => (res = streamingBody(1000, 64 * 1024)));
    const err = await fetchJson(URL_OK, { fetchImpl: f, ...fast, maxBytes: 1024 * 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
    expect((err as InvalidResponseError).reason).toBe('too-large');
    // se dejó de leer poco después del límite (1 MB = 16 trozos de 64 KB), no los 64 MB
    expect((res as unknown as { sent: () => number }).sent()).toBeLessThan(40);
  });

  it('HTML (portal cautivo, página de error) → error de content-type, reintentado como transitorio', async () => {
    const f = fakeFetch(() => jsonResponse('<html>Error</html>', { 'content-type': 'text/html' }));
    const err = await fetchJson(URL_OK, { fetchImpl: f, ...fast }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
    expect((err as InvalidResponseError).reason).toBe('content-type');
    expect(f.calls).toBe(3); // 1 + 2 reintentos
  });

  it('JSON truncado → error de parseo tipado; si el reintento sale bien, se usa', async () => {
    const f = fakeFetch(
      () => jsonResponse('{"events":[{"id":'),
      () => jsonResponse('{"events":[]}'),
    );
    await expect(fetchJson(URL_OK, { fetchImpl: f, ...fast })).resolves.toEqual({ events: [] });
    expect(f.calls).toBe(2);
    const g = fakeFetch(() => jsonResponse('no es json'));
    const err = await fetchJson(URL_OK, { fetchImpl: g, ...fast }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
    expect((err as InvalidResponseError).reason).toBe('parse');
  });

  it('JSON que no es un objeto (array, null, número) → error de forma, sin reintentos', async () => {
    for (const body of ['[]', 'null', '42', '"x"']) {
      const f = fakeFetch(() => jsonResponse(body));
      const err = await fetchJson(URL_OK, { fetchImpl: f, ...fast }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidResponseError);
      expect((err as InvalidResponseError).reason).toBe('shape');
      expect(f.calls).toBe(1);
    }
  });

  it('404 no se reintenta; 503 sí', async () => {
    const f = fakeFetch(() => jsonResponse('{}', {}, 404));
    await expect(fetchJson(URL_OK, { fetchImpl: f, ...fast })).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toBe(1);
    const g = fakeFetch(
      () => jsonResponse('{}', {}, 503),
      () => jsonResponse('{"ok":true}'),
    );
    await expect(fetchJson(URL_OK, { fetchImpl: g, ...fast })).resolves.toEqual({ ok: true });
  });

  it('solo https en *.espn.com (también tras redirecciones)', async () => {
    const f = fakeFetch(() => jsonResponse('{}'));
    for (const u of ['http://site.api.espn.com/x', 'https://evil.example.com/x', 'https://espn.com.evil.io/x', 'file:///etc/passwd']) {
      await expect(fetchJson(u, { fetchImpl: f, ...fast })).rejects.toBeInstanceOf(InvalidResponseError);
    }
    expect(f.calls).toBe(0);
    const redirected = fakeFetch(() => {
      const r = jsonResponse('{}');
      Object.defineProperty(r, 'url', { value: 'https://evil.example.com/x' });
      return r;
    });
    const err = await fetchJson(URL_OK, { fetchImpl: redirected, ...fast }).catch((e) => e);
    expect((err as InvalidResponseError).reason).toBe('host');
    expect(isAllowedUrl(URL_OK)).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('text/html')).toBe(false);
  });

  it('urls de ESPN: slug y parámetros validados', () => {
    expect(() => scoreboardUrl('esp.1/../../x', 2026)).toThrow();
    expect(() => scoreboardUrl('esp.1', '2026-01')).toThrow();
    expect(scoreboardUrl('esp.1', 202611)).toContain('dates=202611');
    expect(summaryUrl('esp.1', '1&x=2')).toContain('event=1%26x%3D2');
  });
});

describe('cortacircuitos', () => {
  it(`tras ${CIRCUIT_THRESHOLD} peticiones fallidas seguidas (red caída) falla al instante sin tocar la red`, async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) await expect(fetchJson(URL_OK, { fetchImpl: f, backoffScale: 0, retries: 0 })).rejects.toThrow('fetch failed');
    expect(isCircuitOpen()).toBe(true);
    const before = f.calls;
    await expect(fetchJson(URL_OK, { fetchImpl: f, backoffScale: 0, retries: 0 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(f.calls).toBe(before);
  });

  it('PIPE-01: los fallos de /summary abren SOLO su circuito; scoreboard y clasificación siguen funcionando', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed (summary)');
    });
    const SUM = summaryUrl('esp.1', '1');
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) await fetchJson(SUM, { fetchImpl: down, backoffScale: 0, retries: 0, circuit: 'summary' }).catch(() => {});
    expect(isCircuitOpen('summary')).toBe(true);
    expect(isCircuitOpen('core')).toBe(false);
    await expect(fetchJson(SUM, { fetchImpl: down, retries: 0, circuit: 'summary' })).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(fetchJson(URL_OK, { fetchImpl: fakeFetch(() => jsonResponse('{"events":[]}')), retries: 0 })).resolves.toEqual({ events: [] });
  });

  it('PIPE-02: las peticiones que esperaban en la cola no salen si el circuito se abre mientras tanto', async () => {
    setConcurrency(1);
    try {
      const SUM = summaryUrl('esp.1', '2');
      const down = fakeFetch(() => {
        throw new TypeError('down');
      });
      // CIRCUIT_THRESHOLD - 1 fallos previos: el siguiente fallo abre el circuito
      for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i++) await fetchJson(SUM, { fetchImpl: down, backoffScale: 0, retries: 0, circuit: 'summary' }).catch(() => {});
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      const slowFail = (async () => {
        calls++;
        await gate;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      // la primera ocupa el único hueco; las demás esperan en la cola mientras esa falla y abre el circuito
      const first = fetchJson(SUM, { fetchImpl: slowFail, backoffScale: 0, retries: 0, circuit: 'summary' }).catch((e) => e);
      const queued = Array.from({ length: 5 }, () => fetchJson(SUM, { fetchImpl: slowFail, backoffScale: 0, retries: 0, circuit: 'summary' }).catch((e) => e));
      release();
      await first;
      const results = await Promise.all(queued);
      expect(isCircuitOpen('summary')).toBe(true);
      expect(results.every((e) => e instanceof CircuitOpenError)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      setConcurrency(6);
    }
  });

  it('PIPE-02: con el plazo vencido no se intenta (ni se reintenta) nada', async () => {
    const f = fakeFetch(() => jsonResponse('{}'));
    await expect(fetchJson(URL_OK, { fetchImpl: f, deadline: Date.now() - 1 })).rejects.toBeInstanceOf(DeadlineError);
    expect(f.calls).toBe(0);
    let t = 0;
    const failing = fakeFetch(() => {
      t++;
      throw new TypeError('fetch failed');
    });
    await expect(fetchJson(URL_OK, { fetchImpl: failing, backoffScale: 0, retries: 4, deadline: Date.now() + 5 }).catch(async (e) => {
      await new Promise((r) => setTimeout(r, 0));
      throw e;
    })).rejects.toBeDefined();
    expect(t).toBeLessThanOrEqual(5);
  });

  it('una respuesta correcta (o un 404) reinicia la cuenta', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i++) await fetchJson(URL_OK, { fetchImpl: down, backoffScale: 0, retries: 0 }).catch(() => {});
    await fetchJson(URL_OK, { fetchImpl: fakeFetch(() => jsonResponse('{}', {}, 404)), backoffScale: 0, retries: 0 }).catch(() => {});
    await fetchJson(URL_OK, { fetchImpl: down, backoffScale: 0, retries: 0 }).catch(() => {});
    expect(isCircuitOpen()).toBe(false);
  });
});
