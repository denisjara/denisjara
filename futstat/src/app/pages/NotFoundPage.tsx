import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, CalendarDays } from 'lucide-react';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface-1/80 px-6 py-16 text-center sm:py-24">
      <div className="pitch-lines pointer-events-none absolute inset-0 opacity-[0.06]" aria-hidden="true" />
      <div className="relative mx-auto max-w-xl">
        <p className="eyebrow text-accent-text">Error 404 · Fuera de juego</p>
        <h1 className="display mt-3 text-[96px] leading-none text-ink-1 sm:text-[140px]">
          4<span className="text-accent-text">0</span>4
        </h1>
        <p className="mt-4 text-[15px] text-ink-2">
          La jugada se ha anulado: la página <code className="num rounded bg-surface-3 px-1.5 py-0.5 text-[13px] text-ink-1">{pathname}</code> no existe o se ha
          movido.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/" className="btn-accent">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Volver al inicio
          </Link>
          <Link to="/partidos" className="btn">
            <CalendarDays className="h-4 w-4" aria-hidden="true" /> Ver partidos
          </Link>
        </div>
      </div>
    </div>
  );
}
