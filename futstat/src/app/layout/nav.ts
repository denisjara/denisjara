import { BadgePercent, CalendarCheck, CalendarDays, Dices, FlaskConical, House, ShieldCheck, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  /** etiqueta corta para la barra inferior móvil (por defecto `label`) */
  short?: string;
  icon: LucideIcon;
  /** coincidencia exacta de ruta (solo Inicio) */
  end?: boolean;
  description: string;
  /** solo en la barra lateral y el cajón: no cabe en la barra inferior móvil (6 huecos) */
  drawerOnly?: boolean;
}

/** Navegación principal (barra lateral + barra inferior móvil). */
export const MAIN_NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: House, end: true, description: 'Partidos del día, picks y titulares' },
  { to: '/hoy', label: 'Pronósticos del día', short: 'Hoy', icon: CalendarCheck, description: 'Los mejores pronósticos de hoy: goles, tiros, córners, tarjetas, faltas y jugadores' },
  {
    to: '/cuota-alta',
    label: 'Cuota alta 6+',
    short: '6+',
    icon: Dices,
    description: 'Apuestas de cuota 6 o más con su probabilidad real, valor esperado e historial (la mayoría pierden)',
    // la barra inferior móvil tiene 6 huecos: en móvil va en el cajón del menú
    drawerOnly: true,
  },
  { to: '/partidos', label: 'Partidos', icon: CalendarDays, description: 'Calendario con predicciones' },
  { to: '/confianza', label: 'Alta confianza', short: 'Confianza', icon: ShieldCheck, description: 'Pronósticos con acierto histórico ≥ 80 %, medido fuera de muestra' },
  { to: '/jugadores', label: 'Jugadores', icon: Users, description: 'Forma y estadísticas de jugadores' },
  { to: '/valor', label: 'Valor', icon: BadgePercent, description: 'Apuestas con valor esperado positivo' },
  { to: '/modelo', label: 'Modelo', icon: FlaskConical, description: 'Metodología y backtest', drawerOnly: true },
];

/** Barra inferior móvil: las 6 entradas de uso diario (el resto —Cuota alta 6+, Modelo— queda en el cajón del menú). */
export const BOTTOM_NAV: NavItem[] = MAIN_NAV.filter((x) => !x.drawerOnly).slice(0, 6);
