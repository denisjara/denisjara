/**
 * «Factores del partido» (MatchFile.factors): validación ESTRICTA del contrato (scripts/validate-data.ts) y
 * normalización defensiva de la app (src/app/lib/sanitize.ts): un bloque malformado nunca tumba la ficha; cada apartado
 * roto se omite y el resto se muestra.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateMatchFactors } from '../../scripts/validate-data';
import { normalizeDataFile, normMatchFactors } from '../../src/app/lib/sanitize';
import type { MatchFactors, MatchFile } from '../../src/types/data';

const ROOT = path.resolve(__dirname, '../..');
const DATE = '2026-11-26T20:00:00Z';

function sample(): MatchFactors {
  return {
    asOf: '2026-11-26T20:00:00.000Z',
    referee: { status: 'conocido', name: 'Árbitro Uno', matches: 24, cardsPerMatch: 4.75, cardsRatio: 1.081, foulsRatio: 0.97, usedInModel: true },
    tie: {
      leg: 2,
      firstLegId: '401929680',
      firstLegDate: '2026-11-19T20:00:00Z',
      firstLeg: { home: 2, away: 0 },
      aggregate: { home: 0, away: 2 },
      leader: 'away',
      summary: 'Benfica pierde 0-2 en el global: necesita ganar por 2 goles para forzar la prórroga o los penaltis (por 3, pasa directamente).',
      usedInModel: false,
    },
    stakes: {
      teams: 20,
      home: { position: 11, points: 45, played: 34, remaining: 4, best: 8, worst: 14, status: 'sin nada en juego', inPlay: [] },
      away: { position: 3, points: 66, played: 34, remaining: 4, best: 1, worst: 6, status: 'título', inPlay: ['Campeón', 'Champions', 'Europa'] },
      usedInModel: false,
    },
    form: {
      home: { last: 6, goalsFor: 1.5, goalsAgainst: 1.17, xgFor: 1.62, xgAgainst: 1.05, netRes: 0.31, label: 'rinde por encima de lo esperado' },
      away: { last: 4, goalsFor: 0.75, goalsAgainst: 1.5, netRes: -0.1, label: 'en línea con lo esperado' },
      usedInModel: false,
    },
    venue: {
      home: { played: 8, w: 5, d: 2, l: 1, gfPerMatch: 1.88, gaPerMatch: 0.75, scope: 'competición' },
      away: { played: 2, w: 0, d: 1, l: 1, gfPerMatch: 0.5, gaPerMatch: 1.5, scope: 'todas' },
      usedInModel: true,
      note: 'ya incluido en córners/tarjetas/tiros por condición',
    },
    absences: {
      home: [
        { playerId: '11', name: 'Jugador Sancionado', kind: 'susp', reason: 'sancionado (expulsado en el último partido)', minutesShare: 0.94, minutesFactor: 0, usedInModel: true },
        { playerId: '12', name: 'Jugador Lesionado', kind: 'miss2', reason: 'no jugó los 2 últimos partidos', minutesShare: 0.8, minutesFactor: 0.65, usedInModel: true },
      ],
      away: [{ playerId: '21', name: 'Jugador Rotado', kind: 'miss1o', reason: 'no jugó el último partido (otra competición)', minutesShare: 0.7, minutesFactor: 1, usedInModel: false }],
    },
    inForm: {
      home: [
        { playerId: '13', name: 'Jugador Trece', formIndex: 81.2, note: '3 goles en los últimos 5 partidos del equipo' },
        { playerId: '14', name: 'Jugador Catorce', formIndex: 70, note: '2 asistencias en los últimos 5 partidos del equipo' },
      ],
      away: [],
      usedInModel: false,
    },
    notes: ['El modelo usa el árbitro (si se conoce), las bajas probables y casa/fuera en córners, tarjetas y tiros.', 'Solo informativo: forma, eliminatoria y lo que se juega.'],
  };
}

const prop = (id: string, formIndex: number) => ({ player: { id, name: `J${id}`, short: id, position: 'M', teamId: 'x' }, formIndex });
const fileOf = (f: unknown, players = { home: [prop('13', 81.2), prop('14', 70), prop('15', 50)], away: [prop('22', 60)] }) => ({
  match: { date: DATE, round: 'Octavos de final · Vuelta' },
  players,
  factors: f,
});
const errs = (f: unknown, file = fileOf(f)) => validateMatchFactors(f, file).join('\n');
/** Copia profunda modificada. */
function mut(fn: (f: Record<string, any>) => void): Record<string, any> {
  const f = JSON.parse(JSON.stringify(sample()));
  fn(f);
  return f;
}

describe('validate-data: factores del partido (estricto)', () => {
  it('un bloque completo y coherente es válido; también el mínimo (árbitro no publicado + notas)', () => {
    expect(errs(sample())).toBe('');
    expect(errs({ asOf: DATE, referee: { status: 'no publicado', usedInModel: false }, notes: ['ESPN aún no ha publicado el árbitro.'] })).toBe('');
  });

  it('rechaza claves desconocidas, campos ausentes y tipos erróneos', () => {
    expect(errs(mut((f) => (f.extra = 1)))).toMatch(/\$\.extra: clave no permitida/);
    expect(errs(mut((f) => (f.form.home.secret = 'x')))).toMatch(/form\.home\.secret: clave no permitida/);
    expect(errs(mut((f) => delete f.notes))).toMatch(/notes: campo requerido ausente/);
    expect(errs(mut((f) => (f.stakes.home.points = '45')))).toMatch(/número esperado/);
    expect(errs(mut((f) => (f.venue.home.played = null)))).toMatch(/null\/NaN\/Infinity/);
  });

  it('árbitro: rangos, «no publicado» nunca usado y coherencia de partidos previos', () => {
    expect(errs(mut((f) => (f.referee.cardsRatio = 3)))).toMatch(/referee: valor no válido/);
    expect(errs(mut((f) => (f.referee = { status: 'no publicado', usedInModel: true })))).toMatch(/referee: valor no válido/);
    expect(errs(mut((f) => (f.referee = { status: 'conocido', name: 'X', matches: 0, cardsRatio: 1, usedInModel: true })))).toMatch(/referee: valor no válido/);
    expect(errs(mut((f) => (f.referee.name = '<script>alert(1)</script>')))).toMatch(/peligroso/);
  });

  it('eliminatoria: global coherente con la ida, líder, frase acotada y solo en una vuelta anterior al partido', () => {
    expect(errs(mut((f) => (f.tie.aggregate = { home: 3, away: 1 })))).toMatch(/el global no corresponde/);
    expect(errs(mut((f) => (f.tie.leader = 'home')))).toMatch(/leader: debe ser "away"/);
    expect(errs(mut((f) => (f.tie.summary = 'x'.repeat(300))))).toMatch(/más de 220 caracteres/);
    expect(errs(mut((f) => (f.tie.usedInModel = true)))).toMatch(/debe ser false/);
    expect(errs(mut((f) => (f.tie.firstLegDate = DATE)))).toMatch(/la ida debe ser anterior/);
    const notVuelta = { ...fileOf(sample()), match: { date: DATE, round: 'Jornada 12' } };
    expect(validateMatchFactors(sample(), notVuelta).join('\n')).toMatch(/no es vuelta/);
  });

  it('lo que se juega: rangos de posición, jornadas y «sin nada en juego» ⇔ ninguna zona', () => {
    expect(errs(mut((f) => (f.stakes.home.position = 21)))).toMatch(/21 > 20/);
    expect(errs(mut((f) => (f.stakes.home.best = 15)))).toMatch(/mejor posición posible > peor/);
    expect(errs(mut((f) => (f.stakes.home.inPlay = ['Descenso'])))).toMatch(/sin nada en juego/);
    expect(errs(mut((f) => (f.stakes.away.remaining = 9)))).toMatch(/jugados \+ restantes/);
    expect(errs(mut((f) => (f.stakes.away.status = 'Europa')))).toMatch(/no permitido/);
  });

  it('forma, casa/fuera, bajas y jugadores en forma', () => {
    expect(errs(mut((f) => (f.form.home.label = 'en línea con lo esperado')))).toMatch(/debe ser "rinde por encima/);
    expect(errs(mut((f) => (f.form.home.last = 9)))).toMatch(/9 > 6/);
    expect(errs(mut((f) => delete f.form.home.xgAgainst))).toMatch(/xgFor y xgAgainst van juntos/);
    expect(errs(mut((f) => (f.venue.home.l = 3)))).toMatch(/w \+ d \+ l ≠ played/);
    expect(errs(mut((f) => (f.absences.home[1].reason = 'lesionado')))).toMatch(/no corresponde a kind/);
    expect(errs(mut((f) => (f.absences.away[0].usedInModel = true)))).toMatch(/minutesFactor ≠ 1/);
    expect(errs(mut((f) => (f.absences.home[0].minutesFactor = 0.5)))).toMatch(/sancionado usado por el modelo no juega/);
    expect(errs(mut((f) => f.absences.home.push(f.absences.home[0])))).toMatch(/jugadores repetidos/);
    expect(errs(mut((f) => f.inForm.home.reverse()))).toMatch(/no está ordenado por formIndex/);
    expect(errs(mut((f) => (f.inForm.home = [1, 2, 3, 4].map((i) => ({ playerId: `x${i}`, name: 'x', formIndex: 50, note: 'n' }))))) ).toMatch(/longitud 4 > 3/);
    expect(errs(mut((f) => (f.notes = []))))
      .toMatch(/longitud 0 < 1/);
  });

  it('coherencia con la ficha: asOf = inicio, sancionado fuera de las props, jugadores en forma de las props', () => {
    expect(errs(mut((f) => (f.asOf = '2026-11-26T18:00:00Z')))).toMatch(/asOf: debe ser el inicio del partido/);
    const withSusp = fileOf(sample(), { home: [prop('13', 81.2), prop('14', 70), prop('11', 40)], away: [] });
    expect(validateMatchFactors(sample(), withSusp).join('\n')).toMatch(/sancionado \(minutesFactor 0\) publicado en las props/);
    const noProp = fileOf(sample(), { home: [prop('13', 81.2)], away: [] });
    expect(validateMatchFactors(sample(), noProp).join('\n')).toMatch(/jugador en forma que no está en las props/);
    const otherIdx = fileOf(sample(), { home: [prop('13', 80), prop('14', 70)], away: [] });
    expect(validateMatchFactors(sample(), otherIdx).join('\n')).toMatch(/no coincide con el de las props/);
  });
});

describe('sanitize: factores del partido', () => {
  it('un bloque válido sale igual (idempotente)', () => {
    expect(normMatchFactors(sample())).toEqual(sample());
  });

  it('basura en cualquier nivel nunca lanza: tipos raros dan undefined o apartados omitidos', () => {
    for (const x of [null, 1, 'x', [], [sample()], true]) expect(normMatchFactors(x)).toBeUndefined();
    const f = normMatchFactors({ referee: 'Mateu', tie: [], stakes: 'x', form: { home: 'x' }, venue: { home: { played: 3, w: 9, d: 0, l: 0 } }, absences: { home: 'x' }, inForm: { home: [null, 1] }, notes: 'x' })!;
    expect(f.referee).toEqual({ status: 'no publicado', usedInModel: false });
    expect(f.notes).toEqual([]);
    for (const k of ['tie', 'stakes', 'form', 'venue', 'absences', 'inForm'] as const) expect(f[k]).toBeUndefined();
  });

  it('apartados parciales: se conserva lo válido y se descarta lo roto', () => {
    const raw = mut((f) => {
      f.referee.cardsRatio = 'NaN';
      f.stakes.home.best = 20; // best > worst
      f.form.home.goalsFor = Infinity;
      f.venue.away.w = 2; // w + d + l ≠ played
      f.absences.home[0].kind = '__proto__';
      f.absences.home[1].minutesShare = -3;
      f.inForm.home[0].formIndex = 1000;
      f.tie.aggregate = { home: 'dos', away: 0 };
    });
    const f = normMatchFactors(raw)!;
    expect(f.referee).toEqual({ status: 'no publicado', usedInModel: false });
    expect(f.stakes).toBeUndefined();
    expect(f.form?.home).toBeUndefined();
    expect(f.form?.away?.last).toBe(4);
    expect(f.venue?.away).toBeUndefined();
    expect(f.venue?.home?.played).toBe(8);
    expect(f.absences?.home.map((a) => a.playerId)).toEqual(['12']);
    expect(f.absences?.home[0].minutesShare).toBe(0);
    expect(f.inForm?.home.map((p) => p.playerId)).toEqual(['14']);
    expect(f.tie).toBeUndefined();
  });

  it('textos acotados y etiqueta desconocida → neutra', () => {
    const f = normMatchFactors(mut((x) => {
      x.form.away.label = 'constructor';
      x.notes = ['a'.repeat(1000)];
      x.absences.home[1].name = 'n'.repeat(500);
    }))!;
    expect(f.form?.away?.label).toBe('en línea con lo esperado');
    expect(Array.from(f.notes[0]).length).toBe(240);
    expect(Array.from(f.absences!.home[1].name).length).toBe(80);
  });

  it('ficha con factores malformados: normalizeDataFile no lanza y el resto de la ficha sigue', () => {
    const dir = path.join(ROOT, 'public/mock-data/matches');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const bad of [42, 'factors', [1, 2], { referee: null, notes: null, absences: { home: [{ kind: 'susp' }] } }]) {
      const out = normalizeDataFile(`matches/${file}`, { ...m, factors: bad }) as MatchFile;
      expect(out.match.id).toBe(m.match.id);
      if (out.factors) expect(out.factors.referee.status).toBe('no publicado');
    }
  });

  it('los factores de los datos de prueba (mock-data) pasan el validador y la normalización no los cambia', () => {
    const dir = path.join(ROOT, 'public/mock-data/matches');
    let n = 0;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!m.factors) continue;
      n++;
      expect(validateMatchFactors(m.factors, m), file).toEqual([]);
      expect(normMatchFactors(m.factors)).toEqual(m.factors);
    }
    expect(n).toBeGreaterThan(0);
  });
});
