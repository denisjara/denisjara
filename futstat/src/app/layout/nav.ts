import { BadgePercent, CalendarDays, FlaskConical, House, ShieldCheck, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  /** etiqueta corta para la barra inferior móvil (por defecto `label`) */
  short?: string;
  icon: LucideIcon;
  /** coincidencia exacta de ruta (solo Inicio) */
  end?: boolean;
  description: string;
}

/** Navegación principal (barra lateral + barra inferior móvil). */
export const MAIN_NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: House, end: true, description: 'Partidos del día, picks y titulares' },
  { to: '/partidos', label: 'Partidos', icon: CalendarDays, description: 'Calendario con predicciones' },
  { to: '/confianza', label: 'Alta confianza', short: 'Confianza', icon: ShieldCheck, description: 'Pronósticos con acierto histórico ≥ 80 %, medido fuera de muestra' },
  { to: '/jugadores', label: 'Jugadores', icon: Users, description: 'Forma y estadísticas de jugadores' },
  { to: '/valor', label: 'Valor', icon: BadgePercent, description: 'Apuestas con valor esperado positivo' },
  { to: '/modelo', label: 'Modelo', icon: FlaskConical, description: 'Metodología y backtest' },
];
