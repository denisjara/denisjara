import { useEffect, useState } from 'react';
import { initials, readableInk, teamColor } from '../lib/colors';
import { safeImageUrl } from '../lib/safeUrl';
import { cx } from './Card';

export interface CrestTeam {
  name: string;
  abbr?: string;
  logo?: string;
  color?: string;
}

export interface TeamCrestProps {
  team: CrestTeam;
  /** lado en px (por defecto 24) */
  size?: number;
  className?: string;
  /** texto alternativo; por defecto decorativo (el nombre suele ir al lado) */
  alt?: string;
}

/**
 * Escudo del equipo. Solo carga imágenes https de ESPN (safeImageUrl); si no hay logo válido o falla la
 * carga, muestra las iniciales sobre el color del equipo (o uno estable derivado del nombre).
 */
export function TeamCrest({ team, size = 24, className, alt }: TeamCrestProps) {
  const name = typeof team?.name === 'string' && team.name ? team.name : '?';
  const logo = safeImageUrl(team?.logo);
  const [failed, setFailed] = useState(false);
  // si cambia el logo (otro equipo en la misma posición), se vuelve a intentar
  useEffect(() => setFailed(false), [logo]);
  const px = Number.isFinite(size) && size > 0 ? size : 24;
  const style = { width: px, height: px };
  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt={alt ?? ''}
        title={name}
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cx('shrink-0 object-contain', className)}
        style={style}
      />
    );
  }
  const bg = teamColor({ name, color: team?.color });
  const ink = readableInk(bg);
  const text = initials(name, team?.abbr);
  const fontSize = Math.max(8, Math.round(px * (text.length > 2 ? 0.34 : 0.42)));
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
      title={name}
      className={cx('inline-flex shrink-0 select-none items-center justify-center rounded-full font-display font-extrabold leading-none tracking-wide ring-1 ring-inset ring-white/15', className)}
      style={{ ...style, background: bg, color: ink, fontSize }}
    >
      {text}
    </span>
  );
}
