import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GoalLedgerKind,
  Prisma,
  SavingsGoalStatus,
} from '@prisma/client';
import { BalancesService } from '../balances/balances.service';
import { InstallmentsService } from '../installments/installments.service';
import { OrganizzeService } from '../organizze/organizze.service';
import { PrismaService } from '../prisma/prisma.module';
import {
  buildAlerts,
  buildInstallmentHints,
  clampPct,
  classifyOrganizzeTx,
  largestIncomeLaunchInMonth,
  cumulativePrimaryPaceBuffer,
  periodSavingsFromCashflow,
  projectWealthAndGoals,
  shiftMonthKey,
  spendableThisMonthCents,
  toGoalProgress,
  weeklySaveTargetCents,
  type ClassifiedTx,
  type GoalProgressInput,
} from './goals-savings.calc';
import type {
  AllocateGoalBody,
  CreateSavingsGoalBody,
  GoalsOverviewDto,
  GoalsSettingsDto,
  SavingsGoalDto,
  UpdateSavingsGoalBody,
} from './goals.types';

function currentMonthKeySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

function todayIsoSaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function yearStartEnd(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function lastDayOfMonth(yearMonth: string): string {
  const y = Number(yearMonth.slice(0, 4));
  const m = Number(yearMonth.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yearMonth}-${String(last).padStart(2, '0')}`;
}

function idsFromJson(value: Prisma.JsonValue): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizze: OrganizzeService,
    private readonly balances: BalancesService,
    private readonly installments: InstallmentsService,
  ) {}

  async getSettings(): Promise<GoalsSettingsDto> {
    this.requireDb();
    const row = await this.ensurePrefs();
    return this.toSettings(row);
  }

  async updateSettings(body: Partial<GoalsSettingsDto>): Promise<GoalsSettingsDto> {
    this.requireDb();
    await this.ensurePrefs();
    const data: Prisma.GoalsPreferenceUpdateInput = {};
    if (body.minPct !== undefined) {
      data.minPct = clampPct(body.minPct);
    }
    if (body.primaryPct !== undefined) {
      data.primaryPct = clampPct(body.primaryPct);
    }
    if (body.idealPct !== undefined) {
      data.idealPct = clampPct(body.idealPct);
    }
    if (body.investmentCategoryIds !== undefined) {
      data.investmentCategoryIds = body.investmentCategoryIds.filter((id) =>
        Number.isFinite(id),
      );
    }
    if (body.estimatedUsdBrl !== undefined) {
      data.estimatedUsdBrl =
        body.estimatedUsdBrl == null || !Number.isFinite(body.estimatedUsdBrl)
          ? null
          : body.estimatedUsdBrl;
    }
    const row = await this.prisma.goalsPreference.update({
      where: { id: 'default' },
      data,
    });
    return this.toSettings(row);
  }

  async listGoals(): Promise<SavingsGoalDto[]> {
    this.requireDb();
    const rows = await this.prisma.savingsGoal.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toGoalDto(row));
  }

  async createGoal(body: CreateSavingsGoalBody): Promise<SavingsGoalDto> {
    this.requireDb();
    const name = body.name.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const targetCents = Math.round(body.targetCents);
    if (!Number.isFinite(targetCents) || targetCents <= 0) {
      throw new BadRequestException('targetCents must be positive');
    }
    const allocatedCents = Math.max(0, Math.round(body.allocatedCents ?? 0));
    const row = await this.prisma.savingsGoal.create({
      data: {
        name,
        targetCents,
        allocatedCents,
        targetDate: body.targetDate
          ? new Date(`${body.targetDate.slice(0, 10)}T00:00:00.000Z`)
          : null,
        priority: body.priority ?? 100,
        monthlyContributionCents: body.monthlyContributionCents ?? null,
        monthlyContributionPct: body.monthlyContributionPct ?? null,
        status:
          allocatedCents >= targetCents
            ? SavingsGoalStatus.COMPLETED
            : SavingsGoalStatus.ACTIVE,
        ledger:
          allocatedCents > 0
            ? {
                create: {
                  date: new Date(`${todayIsoSaoPaulo()}T00:00:00.000Z`),
                  amountCents: allocatedCents,
                  kind: GoalLedgerKind.ADJUSTMENT,
                  note: 'Saldo inicial alocado',
                },
              }
            : undefined,
      },
    });
    return this.toGoalDto(row);
  }

  async updateGoal(
    id: string,
    body: UpdateSavingsGoalBody,
  ): Promise<SavingsGoalDto> {
    this.requireDb();
    const current = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException(`Goal ${id} not found`);
    }
    const targetCents =
      body.targetCents !== undefined
        ? Math.round(body.targetCents)
        : current.targetCents;
    if (targetCents <= 0) {
      throw new BadRequestException('targetCents must be positive');
    }
    let status = current.status;
    if (body.status) {
      status = body.status as SavingsGoalStatus;
    } else if (current.allocatedCents >= targetCents) {
      status = SavingsGoalStatus.COMPLETED;
    } else if (status === SavingsGoalStatus.COMPLETED) {
      status = SavingsGoalStatus.ACTIVE;
    }
    const row = await this.prisma.savingsGoal.update({
      where: { id },
      data: {
        name: body.name !== undefined ? body.name.trim() : undefined,
        targetCents,
        targetDate:
          body.targetDate === undefined
            ? undefined
            : body.targetDate
              ? new Date(`${body.targetDate.slice(0, 10)}T00:00:00.000Z`)
              : null,
        priority: body.priority,
        monthlyContributionCents: body.monthlyContributionCents,
        monthlyContributionPct: body.monthlyContributionPct,
        status,
      },
    });
    return this.toGoalDto(row);
  }

  async deleteGoal(id: string): Promise<{ ok: true }> {
    this.requireDb();
    await this.prisma.savingsGoal.delete({ where: { id } }).catch(() => {
      throw new NotFoundException(`Goal ${id} not found`);
    });
    return { ok: true };
  }

  async allocate(id: string, body: AllocateGoalBody): Promise<SavingsGoalDto> {
    this.requireDb();
    const amountCents = Math.round(body.amountCents);
    if (!Number.isFinite(amountCents) || amountCents === 0) {
      throw new BadRequestException('amountCents must be non-zero');
    }
    const goal = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!goal) {
      throw new NotFoundException(`Goal ${id} not found`);
    }
    const nextAllocated = Math.max(0, goal.allocatedCents + amountCents);
    const date = (body.date ?? todayIsoSaoPaulo()).slice(0, 10);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.goalLedgerEntry.create({
        data: {
          goalId: id,
          date: new Date(`${date}T00:00:00.000Z`),
          amountCents,
          kind: GoalLedgerKind.CONTRIBUTION,
          note: body.note?.trim() || null,
        },
      });
      return tx.savingsGoal.update({
        where: { id },
        data: {
          allocatedCents: nextAllocated,
          status:
            nextAllocated >= goal.targetCents
              ? SavingsGoalStatus.COMPLETED
              : goal.status === SavingsGoalStatus.COMPLETED
                ? SavingsGoalStatus.ACTIVE
                : goal.status,
        },
      });
    });
    return this.toGoalDto(row);
  }

  async overview(monthKey?: string): Promise<GoalsOverviewDto> {
    this.requireDb();
    const month = monthKey && /^\d{4}-\d{2}$/.test(monthKey)
      ? monthKey
      : currentMonthKeySaoPaulo();
    const year = Number(month.slice(0, 4));
    const prefs = await this.ensurePrefs();
    const settings = this.toSettings(prefs);
    const investIds = new Set(settings.investmentCategoryIds);

    // Cashflow from Organizze /balances (not tx sums — avoids fatura double-count).
    const horizon = 24;
    const paceWindowMonths = 12;
    const monthStart = `${month}-01`;
    const monthEnd = lastDayOfMonth(month);
    const { start: yearStart, end: yearEnd } = yearStartEnd(year);
    const paceWindowStartYm = shiftMonthKey(month, -(paceWindowMonths - 1));
    const cashflowFetchStart = `${paceWindowStartYm}-01`;
    const projectionEnd = lastDayOfMonth(shiftMonthKey(month, horizon - 1));
    // Weekly target still needs the largest paycheck launch in the month.
    const txWindowEnd = monthEnd;

    const [yearCashflow, monthlyCashflows, transactions, categories, goals] =
      await Promise.all([
        this.organizze.getPeriodCashflow({
          startDate: yearStart,
          endDate: yearEnd,
        }),
        this.organizze.getMonthlyCashflows({
          startDate: cashflowFetchStart,
          endDate: projectionEnd,
        }),
        this.organizze.listTransactionsCovering({
          startDate: monthStart,
          endDate: txWindowEnd,
        }),
        this.organizze.listCategories(),
        this.prisma.savingsGoal.findMany({
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        }),
      ]);
    const monthCashflow = monthlyCashflows.get(month) ?? {
      incomeCents: 0,
      expenseCents: 0,
    };

    const [snapshot, installmentOverview] = await Promise.all([
      this.balances.getSnapshot().catch(() => null),
      this.installments
        .getOverview(month, {
          preloadedTransactions: transactions,
          skipInvoiceHydration: true,
        })
        .catch(() => null),
    ]);

    const categoryNameById = new Map(
      categories.map((cat) => [cat.id, cat.name] as const),
    );
    const classified: ClassifiedTx[] = transactions.map((tx) =>
      classifyOrganizzeTx(tx, categoryNameById, investIds),
    );

    const targets = {
      minPct: settings.minPct,
      primaryPct: settings.primaryPct,
      idealPct: settings.idealPct,
    };
    const monthSavings = periodSavingsFromCashflow(
      monthCashflow.incomeCents,
      monthCashflow.expenseCents,
      targets,
    );
    // Ano calendário completo (jan–dez) via /balances — inclui previsto.
    const yearSavings = periodSavingsFromCashflow(
      yearCashflow.incomeCents,
      yearCashflow.expenseCents,
      targets,
    );

    // Investments are already booked as Organizze accounts — do not add Pluggy again.
    const bankBalanceCents =
      snapshot?.rows.reduce((sum, row) => sum + row.organizzeBalanceCents, 0) ??
      0;
    const netWorthCents = bankBalanceCents;
    const totalAllocatedCents = goals
      .filter((g) => g.status !== SavingsGoalStatus.PAUSED)
      .reduce((sum, g) => sum + g.allocatedCents, 0);
    const availableCents = Math.max(0, netWorthCents - totalAllocatedCents);

    const goalInputs: GoalProgressInput[] = goals.map((g) => ({
      id: g.id,
      name: g.name,
      targetCents: g.targetCents,
      allocatedCents: g.allocatedCents,
      targetDate: g.targetDate
        ? g.targetDate.toISOString().slice(0, 10)
        : null,
      priority: g.priority,
      monthlyContributionCents: g.monthlyContributionCents,
      monthlyContributionPct: g.monthlyContributionPct,
      status: g.status,
    }));

    const installmentByMonth = new Map<string, number>();
    if (installmentOverview) {
      for (const [ym, detail] of Object.entries(installmentOverview.months)) {
        installmentByMonth.set(ym, detail.committedThisMonthCents);
      }
    }

    // Month figures from Organizze /balances only (no historical average).
    const monthIncomeOzCents = monthCashflow.incomeCents;
    const plannedMonthlySaveCents = Math.round(
      (monthIncomeOzCents * settings.primaryPct) / 100,
    );
    const weeklyTarget = weeklySaveTargetCents(
      largestIncomeLaunchInMonth(classified, month),
      settings.primaryPct,
    );

    const spendableCents = spendableThisMonthCents(monthSavings);

    const paceMonths: Array<{ incomeCents: number; expenseCents: number }> =
      [];
    for (let i = 0; i < paceWindowMonths; i += 1) {
      const ym = shiftMonthKey(paceWindowStartYm, i);
      const cf = monthlyCashflows.get(ym) ?? {
        incomeCents: 0,
        expenseCents: 0,
      };
      paceMonths.push(cf);
    }
    const paceBuffer = cumulativePrimaryPaceBuffer({
      months: paceMonths,
      primaryPct: settings.primaryPct,
    });

    const monthlyNets: number[] = [];
    for (let i = 0; i < horizon; i += 1) {
      const ym = shiftMonthKey(month, i);
      const cf = monthlyCashflows.get(ym);
      if (cf) {
        monthlyNets.push(cf.incomeCents - cf.expenseCents);
        continue;
      }
      // Empty Oz month: fall back to installment commitment only.
      monthlyNets.push(-(installmentByMonth.get(ym) ?? 0));
    }
    const { points: projection, goalEta } = projectWealthAndGoals({
      startYm: month,
      startWealthCents: netWorthCents,
      startAllocatedCents: totalAllocatedCents,
      goals: goalInputs,
      monthlyNets,
      horizon,
    });

    const goalViews = goalInputs.map((g) =>
      toGoalProgress(
        g,
        goalEta.get(g.id) ?? null,
        month,
        plannedMonthlySaveCents,
      ),
    );

    const installmentHints = buildInstallmentHints(installmentByMonth, month);
    const alerts = buildAlerts({
      month: monthSavings,
      year: yearSavings,
      goals: goalViews,
      targets,
      plannedMonthlySaveCents,
      installmentHints,
    });

    const projectionNote =
      'Receita/despesa vêm do /balances do Organizze (igual à UI). Projeção usa o fluxo mensal do Oz; meses vazios só caem parcelas. Alocação a objetivos é virtual.';

    return {
      monthKey: month,
      year,
      settings,
      month: monthSavings,
      yearToDate: yearSavings,
      netWorthCents,
      bankBalanceCents,
      totalAllocatedCents,
      availableCents,
      goals: goalViews,
      projection,
      alerts: alerts.slice(0, 6),
      averageMonthlySpareCents: plannedMonthlySaveCents,
      avgMonthlyIncomeCents: monthIncomeOzCents,
      plannedMonthlySaveCents,
      weeklySaveTargetCents: weeklyTarget,
      spendableCents,
      paceBufferCents: paceBuffer.bufferCents,
      paceBufferSavedPct: paceBuffer.savedPct,
      paceBufferWindowMonths: paceBuffer.windowMonths,
      projectionNote,
    };
  }

  private async ensurePrefs() {
    const existing = await this.prisma.goalsPreference.findUnique({
      where: { id: 'default' },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.goalsPreference.create({
      data: { id: 'default' },
    });
  }

  private toSettings(row: {
    minPct: number;
    primaryPct: number;
    idealPct: number;
    investmentCategoryIds: Prisma.JsonValue;
    estimatedUsdBrl: number | null;
  }): GoalsSettingsDto {
    return {
      minPct: row.minPct,
      primaryPct: row.primaryPct,
      idealPct: row.idealPct,
      investmentCategoryIds: idsFromJson(row.investmentCategoryIds),
      estimatedUsdBrl: row.estimatedUsdBrl,
    };
  }

  private toGoalDto(row: {
    id: string;
    name: string;
    targetCents: number;
    allocatedCents: number;
    targetDate: Date | null;
    priority: number;
    monthlyContributionCents: number | null;
    monthlyContributionPct: number | null;
    status: SavingsGoalStatus;
    createdAt: Date;
    updatedAt: Date;
  }): SavingsGoalDto {
    return {
      id: row.id,
      name: row.name,
      targetCents: row.targetCents,
      allocatedCents: row.allocatedCents,
      targetDate: row.targetDate
        ? row.targetDate.toISOString().slice(0, 10)
        : null,
      priority: row.priority,
      monthlyContributionCents: row.monthlyContributionCents,
      monthlyContributionPct: row.monthlyContributionPct,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private requireDb(): void {
    if (!this.prisma.isEnabled()) {
      throw new BadRequestException('Database is not configured');
    }
  }
}
