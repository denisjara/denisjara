import { BadgePercent, CalendarCheck, CalendarDays, Dices, FlaskConical, House, ShieldCheck, Ticket, Users, type LucideIcon } from 'lucide-react';

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
  },
  {
    to: '/combinada-6',
    label: 'Combinada 6',
    short: 'Comb. 6',
    icon: Ticket,
    description: 'Una pata por partido en mercados distintos: las selecciones más probables que juntas pagan unas 6 veces (la mayoría de días se pierde)',
  },
  { to: '/partidos', label: 'Partidos', icon: CalendarDays, description: 'Calendario con predicciones' },
  { to: '/confianza', label: 'Alta confianza', short: 'Confianza', icon: ShieldCheck, description: 'Pronósticos con acierto histórico ≥ 80 %, medido fuera de muestra' },
  // la barra inferior móvil tiene 6 huecos: Jugadores y Valor van en el cajón del menú para que en el móvil se vean
  // a la primera los apartados de apuestas del día (Hoy, 6+, Combinada 6)
  { to: '/jugadores', label: 'Jugadores', icon: Users, description: 'Forma y estadísticas de jugadores', drawerOnly: true },
  { to: '/valor', label: 'Valor', icon: BadgePercent, description: 'Apuestas con valor esperado positivo', drawerOnly: true },
  { to: '/modelo', label: 'Modelo', icon: FlaskConical, description: 'Metodología y backtest', drawerOnly: true },
];

/** Barra inferior móvil: las 6 entradas de uso diario (el resto —Jugadores, Valor, Modelo— queda en el cajón del menú). */
export const BOTTOM_NAV: NavItem[] = MAIN_NAV.filter((x) => !x.drawerOnly).slice(0, 6);
