import { BadgePercent, CalendarDays, FlaskConical, House, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** coincidencia exacta de ruta (solo Inicio) */
  end?: boolean;
  description: string;
}

/** Navegación principal (barra lateral + barra inferior móvil). */
export const MAIN_NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: House, end: true, description: 'Partidos del día, picks y titulares' },
  { to: '/partidos', label: 'Partidos', icon: CalendarDays, description: 'Calendario con predicciones' },
  { to: '/jugadores', label: 'Jugadores', icon: Users, description: 'Forma y estadísticas de jugadores' },
  { to: '/valor', label: 'Valor', icon: BadgePercent, description: 'Apuestas con valor esperado positivo' },
  { to: '/modelo', label: 'Modelo', icon: FlaskConical, description: 'Metodología y backtest' },
];
