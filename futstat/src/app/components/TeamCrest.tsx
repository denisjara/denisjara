import { useState } from 'react';
import { initials, readableInk, teamColor } from '../lib/colors';
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
 * Escudo del equipo. Si no hay logo o falla la carga, muestra las iniciales sobre el color del
 * equipo (o uno estable derivado del nombre).
 */
export function TeamCrest({ team, size = 24, className, alt }: TeamCrestProps) {
  const [failed, setFailed] = useState(false);
  const showImg = !!team.logo && !failed;
  const style = { width: size, height: size };
  if (showImg) {
    return (
      <img
        src={team.logo}
        alt={alt ?? ''}
        title={team.name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cx('shrink-0 object-contain', className)}
        style={style}
      />
    );
  }
  const bg = teamColor(team);
  const ink = readableInk(bg);
  const text = initials(team.name, team.abbr);
  const fontSize = Math.max(8, Math.round(size * (text.length > 2 ? 0.34 : 0.42)));
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
      title={team.name}
      className={cx('inline-flex shrink-0 select-none items-center justify-center rounded-full font-display font-extrabold leading-none tracking-wide ring-1 ring-inset ring-white/15', className)}
      style={{ ...style, background: bg, color: ink, fontSize }}
    >
      {text}
    </span>
  );
}
