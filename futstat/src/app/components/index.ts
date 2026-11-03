/**
 * Componentes reutilizables de FutStat Lab. API documentada en src/app/DESIGN.md.
 * Importa desde aquí: import { Card, MatchCard, DataTable } from '../components';
 */
export { Card, Section, PageHeader, cx } from './Card';
export type { CardProps, SectionProps, PageHeaderProps } from './Card';
export { TeamCrest } from './TeamCrest';
export type { TeamCrestProps, CrestTeam } from './TeamCrest';
export { ProbBar1X2, Legend1X2 } from './ProbBar1X2';
export type { ProbBar1X2Props } from './ProbBar1X2';
export { FormChips, OutcomeChip } from './FormChips';
export { MatchCard } from './MatchCard';
export type { MatchCardProps } from './MatchCard';
export { MatchRow, Mini1X2, HitMark } from './MatchRow';
export type { MatchRowProps } from './MatchRow';
export { MatchGroup } from './MatchGroup';
export { StatusPill, CompetitionBadge, matchHref } from './MatchStatus';
export { CompetitionHeader } from './CompetitionHeader';
export { Tabs, TabPanel, useUrlTab } from './Tabs';
export type { TabItem } from './Tabs';
export { SegmentedControl } from './SegmentedControl';
export type { SegmentOption } from './SegmentedControl';
export { DataTable } from './DataTable';
export type { Column, DataTableProps } from './DataTable';
export { StatCompareBar, formatStat } from './StatCompareBar';
export type { StatFormat } from './StatCompareBar';
export { Sparkline } from './Sparkline';
export { LineChart, SERIES_COLORS } from './LineChart';
export type { LineSeries, LinePoint } from './LineChart';
export { Heatmap } from './Heatmap';
export { ProbabilityBadge, Meter, ConfidenceMeter, confidenceLabel } from './ProbabilityBadge';
export { OddsButton, ValuePickChip } from './OddsButton';
export { KpiTile } from './KpiTile';
export { Skeleton, SkeletonCard, PageSkeleton, EmptyState, ErrorState } from './States';
export { Tooltip, InfoTip } from './Tooltip';
export { Disclaimer } from './Disclaimer';
