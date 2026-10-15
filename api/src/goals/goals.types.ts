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
  /** Average paid income used for planning (last months with income). */
  avgMonthlyIncomeCents: number;
  /** Expected monthly savings if primaryPct of avg income is kept. */
  plannedMonthlySaveCents: number;
  /** Set aside per weekly paycheck to hit primaryPct. */
  weeklySaveTargetCents: number;
  /** Optional spend left this month without missing primary %. */
  spendableCents: number;
  /** Short explanation of how the chart is built. */
  projectionNote: string;
};
