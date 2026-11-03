import { ShieldAlert } from 'lucide-react';
import { cx } from './Card';
import { ExternalLink } from './ExternalLink';

/**
 * Aviso de juego responsable. Obligatorio en páginas con cuotas, picks de valor o stakes
 * (Inicio, Valor, Partido). `compact` para pies de tarjeta.
 */
export function Disclaimer({ compact, className }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <p className={cx('flex items-start gap-1.5 text-2xs text-ink-3', className)}>
        <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          +18 · Estimaciones estadísticas, no garantías. Juega con responsabilidad.
        </span>
      </p>
    );
  }
  return (
    <aside aria-label="Juego responsable" className={cx('flex items-start gap-3 rounded-card border border-line bg-surface-1/70 p-4 text-[12.5px] text-ink-2', className)}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong font-display text-[13px] font-extrabold text-ink-1" aria-hidden="true">
        18+
      </span>
      <div>
        <p className="font-semibold text-ink-1">Juego responsable</p>
        <p className="mt-0.5">
          FutStat Lab publica probabilidades calculadas con modelos estadísticos a partir de datos públicos. No son consejos de apuesta
          ni garantizan resultados: el fútbol tiene una gran varianza y las cuotas cambian. Si apuestas, hazlo solo si eres mayor de edad,
          con dinero que puedas permitirte perder y fijando límites. Ayuda y autoexclusión en{' '}
          <ExternalLink className="link" href="https://www.jugarbien.es">
            jugarbien.es
          </ExternalLink>
          .
        </p>
      </div>
    </aside>
  );
}
