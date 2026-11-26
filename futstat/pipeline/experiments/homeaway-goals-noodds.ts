/**
 * FACTOR: RENDIMIENTO LOCAL / VISITANTE POR EQUIPO — configuración 2 de 4 (pre-registro completo, hipótesis, regla y
 * lista de configuraciones en la cabecera de homeaway-goals.ts, escrito el 2026-11-26 ANTES de evaluar).
 * Hipótesis (a): ventaja local propia por equipo (residuo casa − fuera frente a Elo y a la ventaja de la competición,
 * contracción empírico-bayesiana) aplicada SOLO a partidos sin cuotas (sin mercado el ensamble es Elo + goles, que no
 * la recogen; con cuotas = producción).
 * MÉTRICAS OBJETIVO: 1X2 RPS (`rps`) y goles por equipo Brier (`teamGoals`). T1 declarada «sin muestra» (14 partidos
 * sin cuotas); se juzga en T2 y prev.
 *
 * RESULTADO (2026-11-26, frente a production): τ² EB = 0 desde febrero ⇒ idéntica a producción en T1/T2 y casi en
 * prev (RPS +0,0000000; sin cuotas de prev n = 2.344 sin cambio apreciable). NO SE ADOPTA (ver homeaway-goals.ts).
 */
import { makeHomeAwayGoalsVariant } from './homeaway/make';

export default makeHomeAwayGoalsVariant(
  'homeaway-goals-noodds',
  'Ventaja local propia por equipo (contracción EB) → delta de la supremacía, solo partidos SIN cuotas',
  { apply: 'noOdds' },
);
