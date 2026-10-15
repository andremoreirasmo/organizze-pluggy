export type ClassifiedTx = {
  id: number;
  date: string;
  paid: boolean;
  amountCents: number;
  accountId: number | null;
  creditCardId: number | null;
  categoryId: number | null;
  categoryName: string | null;
  isTransfer: boolean;
  isInvestmentContribution: boolean;
  /** Bank debit that pays a credit-card bill — not new consumption. */
  isInvoicePayment: boolean;
};

export type SavingsTargetsPct = {
  minPct: number;
  primaryPct: number;
  idealPct: number;
};

export type PeriodSavings = {
  /** All income in the period (paid flag ignored — treated as efetivado). */
  incomePaidCents: number;
  /** Deprecated: always 0; unpaid income is included in incomePaidCents. */
  incomePlannedCents: number;
  /** All consumption in the period (paid flag ignored). */
  consumptionPaidCents: number;
  investmentContribPaidCents: number;
  savedCents: number;
  savedPct: number | null;
  targetMinCents: number;
  targetPrimaryCents: number;
  targetIdealCents: number;
  gapPrimaryCents: number;
};

const INVEST_NAME_RE =
  /invest|aplica[cç][aã]o|aporte|tesouro|cdb|lci|lca|fundo|fii\b|bolsa|a[cç][oõ]es/i;

/** Same idea as balances/reconciliation — paying a bill is not new spending. */
const INVOICE_PAYMENT_RE =
  /pagamento\s+d[eo]\s+fatura|pagto\.?\s*fatura|pag\.?\s*fatura/i;

export function isTransferLike(tx: {
  oposite_transaction_id?: number | null;
  oposite_account_id?: number | null;
}): boolean {
  return (
    tx.oposite_transaction_id != null || tx.oposite_account_id != null
  );
}

export function isInvestmentContributionName(
  categoryName: string | null | undefined,
): boolean {
  if (!categoryName) {
    return false;
  }
  return INVEST_NAME_RE.test(categoryName);
}

export function isInvoicePaymentLabel(
  categoryName: string | null | undefined,
  description?: string | null,
): boolean {
  if (categoryName && INVOICE_PAYMENT_RE.test(categoryName)) {
    return true;
  }
  if (description && INVOICE_PAYMENT_RE.test(description)) {
    return true;
  }
  return false;
}

export function classifyOrganizzeTx(
  tx: {
    id: number;
    date: string;
    paid: boolean;
    amount_cents: number;
    account_id: number | null;
    credit_card_id: number | null;
    category_id: number | null;
    description?: string | null;
    oposite_transaction_id?: number | null;
    oposite_account_id?: number | null;
  },
  categoryNameById: Map<number, string>,
  investmentCategoryIds: Set<number>,
): ClassifiedTx {
  const categoryId = tx.category_id;
  const categoryName =
    categoryId != null ? (categoryNameById.get(categoryId) ?? null) : null;
  const isTransfer = isTransferLike(tx);
  const isInvoicePayment =
    !isTransfer &&
    tx.amount_cents < 0 &&
    isInvoicePaymentLabel(categoryName, tx.description);
  const isInvestmentContribution =
    !isTransfer &&
    !isInvoicePayment &&
    tx.amount_cents < 0 &&
    ((categoryId != null && investmentCategoryIds.has(categoryId)) ||
      isInvestmentContributionName(categoryName));
  return {
    id: tx.id,
    date: tx.date.slice(0, 10),
    paid: tx.paid,
    amountCents: tx.amount_cents,
    accountId: tx.account_id,
    creditCardId: tx.credit_card_id,
    categoryId,
    categoryName,
    isTransfer,
    isInvestmentContribution,
    isInvoicePayment,
  };
}

export function inMonth(isoDate: string, yearMonth: string): boolean {
  return isoDate.slice(0, 7) === yearMonth;
}

export function inYear(isoDate: string, year: number): boolean {
  return Number(isoDate.slice(0, 4)) === year;
}

export function computePeriodSavings(
  txs: ClassifiedTx[],
  targets: SavingsTargetsPct,
  filter: (tx: ClassifiedTx) => boolean,
): PeriodSavings {
  // Treat every matching launch as efetivado (ignore Organizze paid flag) so
  // planning reflects the full scheduled cashflow, not only what is checked off.
  let incomePaidCents = 0;
  let consumptionPaidCents = 0;
  let investmentContribPaidCents = 0;

  for (const tx of txs) {
    if (!filter(tx) || tx.isTransfer || tx.isInvoicePayment) {
      continue;
    }
    if (tx.amountCents > 0 && tx.accountId != null && tx.creditCardId == null) {
      incomePaidCents += tx.amountCents;
      continue;
    }
    if (tx.amountCents < 0) {
      const abs = Math.abs(tx.amountCents);
      if (tx.isInvestmentContribution) {
        investmentContribPaidCents += abs;
      } else {
        consumptionPaidCents += abs;
      }
    }
  }

  const savedCents =
    incomePaidCents - consumptionPaidCents + investmentContribPaidCents;
  const savedPct =
    incomePaidCents > 0 ? (savedCents / incomePaidCents) * 100 : null;
  const targetMinCents = Math.round((incomePaidCents * targets.minPct) / 100);
  const targetPrimaryCents = Math.round(
    (incomePaidCents * targets.primaryPct) / 100,
  );
  const targetIdealCents = Math.round((incomePaidCents * targets.idealPct) / 100);

  return {
    incomePaidCents,
    /** Always 0 — unpaid is folded into incomePaidCents for analysis. */
    incomePlannedCents: 0,
    consumptionPaidCents,
    investmentContribPaidCents,
    savedCents,
    savedPct,
    targetMinCents,
    targetPrimaryCents,
    targetIdealCents,
    gapPrimaryCents: Math.max(0, targetPrimaryCents - savedCents),
  };
}

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

export type GoalProgressInput = {
  id: string;
  name: string;
  targetCents: number;
  allocatedCents: number;
  targetDate: string | null;
  priority: number;
  monthlyContributionCents: number | null;
  monthlyContributionPct: number | null;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
};

export type GoalProgressView = GoalProgressInput & {
  remainingCents: number;
  progressPct: number;
  pace: 'ahead' | 'on_track' | 'behind' | 'no_date' | 'done';
  estimatedMonth: string | null;
  /** Months from todayYm through target month (inclusive). Null if no target. */
  monthsRemaining: number | null;
  /** What to set aside each month to hit the target date. */
  requiredMonthlyCents: number | null;
};

/** Inclusive month span: 2026-10 → 2027-12 = 15. Past dates return 0. */
export function monthsInclusive(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  const delta = (ty - fy) * 12 + (tm - fm);
  if (delta < 0) {
    return 0;
  }
  return delta + 1;
}

export function requiredMonthlyForGoal(
  remainingCents: number,
  monthsRemaining: number,
): number {
  if (remainingCents <= 0) {
    return 0;
  }
  if (monthsRemaining <= 0) {
    return remainingCents;
  }
  return Math.ceil(remainingCents / monthsRemaining);
}

export function toGoalProgress(
  goal: GoalProgressInput,
  estimatedMonth: string | null,
  todayYm: string,
  monthlySpareCents = 0,
): GoalProgressView {
  const remainingCents = Math.max(0, goal.targetCents - goal.allocatedCents);
  const progressPct =
    goal.targetCents > 0
      ? Math.min(100, (goal.allocatedCents / goal.targetCents) * 100)
      : 0;

  if (goal.status === 'COMPLETED' || remainingCents === 0) {
    return {
      ...goal,
      remainingCents: 0,
      progressPct: 100,
      pace: 'done',
      estimatedMonth: estimatedMonth ?? todayYm,
      monthsRemaining: 0,
      requiredMonthlyCents: 0,
    };
  }

  if (!goal.targetDate) {
    return {
      ...goal,
      remainingCents,
      progressPct,
      pace: 'no_date',
      estimatedMonth,
      monthsRemaining: null,
      requiredMonthlyCents: null,
    };
  }

  const targetYm = goal.targetDate.slice(0, 7);
  const monthsRemaining = monthsInclusive(todayYm, targetYm);
  const requiredMonthlyCents = requiredMonthlyForGoal(
    remainingCents,
    monthsRemaining,
  );

  let pace: GoalProgressView['pace'] = 'behind';
  if (monthsRemaining <= 0) {
    pace = 'behind';
  } else if (monthlySpareCents >= requiredMonthlyCents * 1.2) {
    pace = 'ahead';
  } else if (monthlySpareCents >= requiredMonthlyCents) {
    pace = 'on_track';
  } else if (
    estimatedMonth != null &&
    estimatedMonth <= targetYm &&
    monthlySpareCents > 0
  ) {
    // ETA hits the date even if average spare is slightly below the flat required rate
    // (e.g. free cash already available to allocate).
    pace = 'on_track';
  }

  return {
    ...goal,
    remainingCents,
    progressPct,
    pace,
    estimatedMonth,
    monthsRemaining,
    requiredMonthlyCents,
  };
}

/** Greedy monthly allocation by priority (lower number = higher priority). */
export function estimateGoalMonths(params: {
  goals: GoalProgressInput[];
  monthlySpareCents: number;
  startYm: string;
  horizonMonths: number;
  /** Free capital already available (not allocated to any goal). Applied in month 0. */
  initialBonusCents?: number;
}): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const active = params.goals
    .filter((g) => g.status === 'ACTIVE')
    .slice()
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const remaining = new Map(
    active.map((g) => [g.id, Math.max(0, g.targetCents - g.allocatedCents)]),
  );
  for (const g of active) {
    if ((remaining.get(g.id) ?? 0) <= 0) {
      result.set(g.id, params.startYm);
    }
  }

  const applySpare = (spareIn: number, ym: string): void => {
    let spare = spareIn;
    for (const g of active) {
      const left = remaining.get(g.id) ?? 0;
      if (left <= 0 || spare <= 0) {
        continue;
      }
      let contribution = spare;
      if (
        g.monthlyContributionCents != null &&
        g.monthlyContributionCents > 0
      ) {
        contribution = Math.min(spare, g.monthlyContributionCents);
      } else if (
        g.monthlyContributionPct != null &&
        g.monthlyContributionPct > 0
      ) {
        contribution = Math.min(
          spare,
          Math.round((params.monthlySpareCents * g.monthlyContributionPct) / 100),
        );
      }
      if (contribution <= 0) {
        continue;
      }
      const applied = Math.min(left, contribution);
      remaining.set(g.id, left - applied);
      spare -= applied;
      if ((remaining.get(g.id) ?? 0) <= 0 && !result.has(g.id)) {
        result.set(g.id, ym);
      }
    }
  };

  const bonus = Math.max(0, params.initialBonusCents ?? 0);
  if (bonus > 0) {
    applySpare(bonus, params.startYm);
  }

  if (params.monthlySpareCents <= 0) {
    for (const g of active) {
      if (!result.has(g.id)) {
        result.set(g.id, null);
      }
    }
    return result;
  }

  let ym = params.startYm;
  for (let i = 0; i < params.horizonMonths; i += 1) {
    applySpare(params.monthlySpareCents, ym);
    ym = shiftMonthKey(ym, 1);
  }
  for (const g of active) {
    if (!result.has(g.id)) {
      result.set(g.id, null);
    }
  }
  return result;
}

function isIncomeTx(tx: ClassifiedTx): boolean {
  return (
    !tx.isTransfer &&
    tx.amountCents > 0 &&
    tx.accountId != null &&
    tx.creditCardId == null
  );
}

/** Sum income (paid or not) per month for months ≤ fromYm. */
export function incomeByMonth(
  txs: ClassifiedTx[],
  fromYm: string,
): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const tx of txs) {
    if (!isIncomeTx(tx)) {
      continue;
    }
    const ym = tx.date.slice(0, 7);
    if (ym > fromYm) {
      continue;
    }
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + tx.amountCents);
  }
  return byMonth;
}

/**
 * Average monthly income for planning.
 * Prefers the last `lookback` months that actually had income; falls back to
 * any month in range.
 */
export function estimateAverageMonthlyIncome(
  txs: ClassifiedTx[],
  fromYm: string,
  lookback = 3,
): number {
  const byMonth = incomeByMonth(txs, fromYm);
  const recent: number[] = [];
  for (let i = 0; i <= lookback + 5 && recent.length < lookback; i += 1) {
    const ym = shiftMonthKey(fromYm, -i);
    const cents = byMonth.get(ym) ?? 0;
    if (cents > 0) {
      recent.push(cents);
    }
  }
  if (recent.length > 0) {
    return Math.round(
      recent.reduce((sum, value) => sum + value, 0) / recent.length,
    );
  }

  const samples = [...byMonth.values()].filter((v) => v > 0);
  if (samples.length === 0) {
    return 0;
  }
  return Math.round(
    samples.reduce((sum, value) => sum + value, 0) / samples.length,
  );
}

/**
 * Planned monthly wealth growth assuming the user keeps saving `primaryPct` of
 * average income. Known unpaid expenses + installments above the spending
 * budget (100% − primaryPct) reduce that capacity.
 */
export function buildPlannedMonthlyNets(params: {
  txs: ClassifiedTx[];
  installmentByMonth: Map<string, number>;
  fromYm: string;
  horizon: number;
  avgMonthlyIncomeCents: number;
  primaryPct: number;
}): number[] {
  const {
    txs,
    installmentByMonth,
    fromYm,
    horizon,
    avgMonthlyIncomeCents,
    primaryPct,
  } = params;
  const baselineSave = Math.round((avgMonthlyIncomeCents * primaryPct) / 100);
  const baselineSpend = Math.max(0, avgMonthlyIncomeCents - baselineSave);
  const nets: number[] = [];

  // Without an income baseline, parcel-only months would fake a decline then a
  // flat line — keep the chart honest (no invented growth or drain).
  if (avgMonthlyIncomeCents <= 0 && baselineSave <= 0) {
    return Array.from({ length: horizon }, () => 0);
  }

  for (let i = 0; i < horizon; i += 1) {
    const ym = shiftMonthKey(fromYm, i);
    // Future months: use scheduled launches as efetivado (ignore paid flag).
    const monthIncome = txs
      .filter((tx) => inMonth(tx.date, ym) && isIncomeTx(tx))
      .reduce((sum, tx) => sum + tx.amountCents, 0);
    const monthExpense = txs
      .filter(
        (tx) =>
          inMonth(tx.date, ym) &&
          !tx.isTransfer &&
          !tx.isInvoicePayment &&
          !tx.isInvestmentContribution &&
          tx.amountCents < 0,
      )
      .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
    const parcels = installmentByMonth.get(ym) ?? 0;

    // Default path: user keeps saving primaryPct of average income.
    if (monthIncome === 0 && monthExpense === 0) {
      // Known installments reduce capacity only when they exceed the spend budget.
      const overBudget = Math.max(0, parcels - baselineSpend);
      nets.push(baselineSave - overBudget);
      continue;
    }

    const income = monthIncome > 0 ? monthIncome : avgMonthlyIncomeCents;
    const knownSpend = monthExpense + parcels;
    const spend =
      knownSpend > 0 ? Math.max(baselineSpend, knownSpend) : baselineSpend;
    nets.push(income - spend);
  }
  return nets;
}

/** Target to set aside from each weekly paycheck (avg monthly × pct / ~4.33). */
export function weeklySaveTargetCents(
  avgMonthlyIncomeCents: number,
  primaryPct: number,
): number {
  if (avgMonthlyIncomeCents <= 0) {
    return 0;
  }
  const monthlySave = Math.round((avgMonthlyIncomeCents * primaryPct) / 100);
  return Math.round(monthlySave / (52 / 12));
}

/**
 * How much can still be spent this month without missing the primary % goal.
 * Income/consumption already treat all launches as efetivado.
 */
export function spendableThisMonthCents(params: {
  month: PeriodSavings;
  parcelsThisMonthCents: number;
  primaryPct: number;
}): number {
  const income =
    params.month.incomePaidCents + params.month.incomePlannedCents;
  if (income <= 0) {
    return 0;
  }
  const targetPrimary = Math.round((income * params.primaryPct) / 100);
  const afterTarget = income - targetPrimary;
  const alreadyCommitted =
    params.month.consumptionPaidCents + params.parcelsThisMonthCents;
  return Math.max(0, afterTarget - alreadyCommitted);
}

export function shiftMonthKey(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const abs = y * 12 + (m - 1) + delta;
  const ny = Math.floor(abs / 12);
  const nm = (abs % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function formatBrlAlert(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function monthLabelShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

export function buildAlerts(params: {
  month: PeriodSavings;
  year: PeriodSavings;
  goals: GoalProgressView[];
  targets: SavingsTargetsPct;
  plannedMonthlySaveCents?: number;
  installmentHints?: string[];
}): string[] {
  const alerts: string[] = [];
  const { month, year, goals, targets } = params;
  if (month.incomePaidCents > 0 && month.savedCents >= month.targetPrimaryCents) {
    alerts.push('Você já atingiu sua meta de economia do mês.');
  } else if (month.gapPrimaryCents > 0 && month.incomePaidCents > 0) {
    alerts.push(
      `Faltam R$ ${formatBrlAlert(month.gapPrimaryCents)} para a meta principal (${targets.primaryPct}%) deste mês.`,
    );
  }
  if (
    year.savedCents < 0 &&
    year.incomePaidCents > 0 &&
    month.savedCents >= 0
  ) {
    alerts.push(
      `No ano o resultado está negativo (R$ ${formatBrlAlert(year.savedCents)}) por gastos acumulados; no mês corrente a economia está ${month.savedCents >= month.targetPrimaryCents ? 'na meta' : 'em formação'}.`,
    );
  } else if (
    year.savedPct != null &&
    year.savedPct >= targets.primaryPct &&
    year.incomePaidCents > 0
  ) {
    alerts.push('Sua economia acumulada no ano está acima do planejado.');
  }
  for (const hint of params.installmentHints ?? []) {
    alerts.push(hint);
  }
  for (const goal of goals) {
    if (goal.pace === 'done') {
      continue;
    }
    if (goal.estimatedMonth) {
      const label = monthLabelShort(goal.estimatedMonth);
      const planned = params.plannedMonthlySaveCents;
      const req = goal.requiredMonthlyCents;
      if (planned != null && req != null) {
        alerts.push(
          `“${goal.name}”: com ~R$ ${formatBrlAlert(planned)}/mês planejados (precisa R$ ${formatBrlAlert(req)}/mês), previsão ${label} — sem usar o que já está alocado em outros objetivos.`,
        );
      } else {
        alerts.push(
          `Com a economia planejada, “${goal.name}” chega em ${label}.`,
        );
      }
    } else if (goal.pace === 'behind' && goal.requiredMonthlyCents != null) {
      alerts.push(
        `“${goal.name}” está abaixo do ritmo: precisa de R$ ${formatBrlAlert(goal.requiredMonthlyCents)}/mês até a data-alvo.`,
      );
    }
  }
  return alerts.slice(0, 6);
}

/** Actionable installment copy from committed amounts by month. */
export function buildInstallmentHints(
  installmentByMonth: Map<string, number>,
  fromYm: string,
): string[] {
  const hints: string[] = [];
  const entries = [...installmentByMonth.entries()]
    .filter(([ym]) => ym >= fromYm)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return hints;
  }
  const [nearYm, nearCents] = entries[0];
  if (nearCents > 0) {
    hints.push(
      `R$ ${formatBrlAlert(nearCents)} em parcelas previstas para ${monthLabelShort(nearYm)}.`,
    );
  }
  let endingSoon = 0;
  for (const [ym, cents] of entries) {
    if (ym > shiftMonthKey(fromYm, 3)) {
      break;
    }
    const next = installmentByMonth.get(shiftMonthKey(ym, 1)) ?? 0;
    if (cents > next) {
      endingSoon += cents - next;
    }
  }
  if (endingSoon > 0) {
    hints.push(
      `R$ ${formatBrlAlert(endingSoon)} em parcelas diminuem nos próximos 3 meses.`,
    );
  }
  return hints;
}

export type ProjectionPoint = {
  monthKey: string;
  netCents: number;
  wealthCents: number;
  allocatedCents: number;
  availableCents: number;
  scenario: 'base';
};

export function projectWealth(params: {
  startYm: string;
  startWealthCents: number;
  startAllocatedCents: number;
  monthlyNets: number[];
  horizon: number;
}): ProjectionPoint[] {
  const points: ProjectionPoint[] = [];
  let wealth = params.startWealthCents;
  const allocated = params.startAllocatedCents;
  // Point 0 = patrimônio hoje (matches the KPI). Growth applies from month 1.
  points.push({
    monthKey: params.startYm,
    netCents: 0,
    wealthCents: wealth,
    allocatedCents: allocated,
    availableCents: wealth - allocated,
    scenario: 'base',
  });
  for (let i = 0; i < Math.max(0, params.horizon - 1); i += 1) {
    const net = params.monthlyNets[i] ?? 0;
    wealth += net;
    points.push({
      monthKey: shiftMonthKey(params.startYm, i + 1),
      netCents: net,
      wealthCents: wealth,
      allocatedCents: allocated,
      availableCents: wealth - allocated,
      scenario: 'base',
    });
  }
  return points;
}
