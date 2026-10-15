import type {
  GoalProgressView,
  PeriodSavings,
  ProjectionPoint,
  SavingsTargetsPct,
} from './goals-savings.calc';

export type GoalsSettingsDto = SavingsTargetsPct & {
  investmentCategoryIds: number[];
  estimatedUsdBrl: number | null;
};

export type SavingsGoalDto = {
  id: string;
  name: string;
  targetCents: number;
  allocatedCents: number;
  targetDate: string | null;
  priority: number;
  monthlyContributionCents: number | null;
  monthlyContributionPct: number | null;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
  createdAt: string;
  updatedAt: string;
};

export type CreateSavingsGoalBody = {
  name: string;
  targetCents: number;
  allocatedCents?: number;
  targetDate?: string | null;
  priority?: number;
  monthlyContributionCents?: number | null;
  monthlyContributionPct?: number | null;
};

export type UpdateSavingsGoalBody = {
  name?: string;
  targetCents?: number;
  targetDate?: string | null;
  priority?: number;
  monthlyContributionCents?: number | null;
  monthlyContributionPct?: number | null;
  status?: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
};

export type AllocateGoalBody = {
  amountCents: number;
  note?: string;
  date?: string;
};

export type GoalsOverviewDto = {
  monthKey: string;
  year: number;
  settings: GoalsSettingsDto;
  month: PeriodSavings;
  yearToDate: PeriodSavings;
  /** Oz account balances only (investments already booked in Organizze). */
  netWorthCents: number;
  bankBalanceCents: number;
  totalAllocatedCents: number;
  availableCents: number;
  goals: GoalProgressView[];
  projection: ProjectionPoint[];
  alerts: string[];
  /** @deprecated Prefer plannedMonthlySaveCents — kept for older clients. */
  averageMonthlySpareCents: number;
  /** Organizze income in the selected month (all launches as efetivado). */
  avgMonthlyIncomeCents: number;
  /** primaryPct of that month's Organizze income. */
  plannedMonthlySaveCents: number;
  /** primaryPct of the largest income launch in the month. */
  weeklySaveTargetCents: number;
  /** Optional spend left this month without missing primary %. */
  spendableCents: number;
  /**
   * Rolling ~12m pace vs primary %: saved − target.
   * >0 folga acumulada; <0 falta pra recuperar a meta %.
   */
  paceBufferCents: number;
  /** Actual save rate over the pace window (null if no income). */
  paceBufferSavedPct: number | null;
  /** How many calendar months entered the pace window (usually 12). */
  paceBufferWindowMonths: number;
  /** Short explanation of how the chart is built. */
  projectionNote: string;
};
