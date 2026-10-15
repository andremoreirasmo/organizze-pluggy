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
  /**
   * Income from Organizze `/balances` (`predicted_incomes`, full period total).
   */
  incomePaidCents: number;
  /** Always 0; kept for API compat. */
  incomePlannedCents: number;
  /**
   * Expense from Organizze `/balances` (`predicted_expenses`, full period total).
   * Prefer balances over summing txs (avoids fatura double-count).
   */
  consumptionPaidCents: number;
  /** Always 0; kept for API compat. */
  investmentContribPaidCents: number;
  /** Savings: income − expense. */
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
  /pagamento\s+d[eo]\s+fatura|pagto\.?\s*fatura|pag\.?\s*fatura|pagamento.*fatura|^fatura\b/i;

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
    paid_credit_card_id?: number | null;
    paid_credit_card_invoice_id?: number | null;
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
    (tx.paid_credit_card_id != null ||
      tx.paid_credit_card_invoice_id != null ||
      isInvoicePaymentLabel(categoryName, tx.description));
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

/**
 * Preferred path: totals from Organizze GET /balances (no tx summing / fatura dup).
 */
export function periodSavingsFromCashflow(
  incomeCents: number,
  expenseCents: number,
  targets: SavingsTargetsPct,
): PeriodSavings {
  const incomePaidCents = Math.max(0, Math.round(incomeCents));
  const consumptionPaidCents = Math.max(0, Math.round(expenseCents));
  const savedCents = incomePaidCents - consumptionPaidCents;
  const savedPct =
    incomePaidCents > 0 ? (savedCents / incomePaidCents) * 100 : null;
  const targetMinCents = Math.round((incomePaidCents * targets.minPct) / 100);
  const targetPrimaryCents = Math.round(
    (incomePaidCents * targets.primaryPct) / 100,
  );
  const targetIdealCents = Math.round(
    (incomePaidCents * targets.idealPct) / 100,
  );
  return {
    incomePaidCents,
    incomePlannedCents: 0,
    consumptionPaidCents,
    investmentContribPaidCents: 0,
    savedCents,
    savedPct,
    targetMinCents,
    targetPrimaryCents,
    targetIdealCents,
    gapPrimaryCents: Math.max(0, targetPrimaryCents - savedCents),
  };
}

export function computePeriodSavings(
  txs: ClassifiedTx[],
  targets: SavingsTargetsPct,
  filter: (tx: ClassifiedTx) => boolean,
): PeriodSavings {
  // Fallback only — prefer periodSavingsFromCashflow (/balances).
  // Never count invoice payments together with card purchases.
  let incomePaidCents = 0;
  let consumptionPaidCents = 0;

  for (const tx of txs) {
    if (!filter(tx) || tx.isTransfer || tx.isInvoicePayment) {
      continue;
    }
    if (tx.amountCents > 0 && tx.accountId != null && tx.creditCardId == null) {
      incomePaidCents += tx.amountCents;
      continue;
    }
    if (tx.amountCents < 0) {
      consumptionPaidCents += Math.abs(tx.amountCents);
    }
  }

  return periodSavingsFromCashflow(
    incomePaidCents,
    consumptionPaidCents,
    targets,
  );
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
  } else if (estimatedMonth != null && estimatedMonth <= targetYm) {
    // Shared projection reaches the target date (includes free cash + Oz nets).
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

function isConsumptionTx(tx: ClassifiedTx): boolean {
  // Fallback tx path: skip invoice payments so fatura is not double-counted.
  return (
    !tx.isTransfer &&
    !tx.isInvoicePayment &&
    tx.amountCents < 0
  );
}

/** Total Organizze income in a month (paid + scheduled). No averaging. */
export function organizzeIncomeInMonth(
  txs: ClassifiedTx[],
  yearMonth: string,
): number {
  return txs
    .filter((tx) => inMonth(tx.date, yearMonth) && isIncomeTx(tx))
    .reduce((sum, tx) => sum + tx.amountCents, 0);
}

/** Total Organizze consumption in a month (paid + scheduled). */
export function organizzeConsumptionInMonth(
  txs: ClassifiedTx[],
  yearMonth: string,
): number {
  return txs
    .filter((tx) => inMonth(tx.date, yearMonth) && isConsumptionTx(tx))
    .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
}

/**
 * Monthly wealth nets from Organizze launches only.
 * Does not invent income for empty months. Installments are used only when
 * that month has no consumption txs (avoids double-counting card parcels).
 */
export function buildOrganizzeMonthlyNets(params: {
  txs: ClassifiedTx[];
  installmentByMonth: Map<string, number>;
  fromYm: string;
  horizon: number;
}): number[] {
  const nets: number[] = [];
  for (let i = 0; i < params.horizon; i += 1) {
    const ym = shiftMonthKey(params.fromYm, i);
    const income = organizzeIncomeInMonth(params.txs, ym);
    const expense = organizzeConsumptionInMonth(params.txs, ym);
    const parcels = params.installmentByMonth.get(ym) ?? 0;
    const spend = expense > 0 ? expense : parcels;
    nets.push(income - spend);
  }
  return nets;
}

/**
 * @deprecated Use organizzeIncomeInMonth / buildOrganizzeMonthlyNets.
 * Kept as a thin alias so older call sites compile during migration.
 */
export function estimateAverageMonthlyIncome(
  txs: ClassifiedTx[],
  fromYm: string,
  _lookback = 3,
): number {
  return organizzeIncomeInMonth(txs, fromYm);
}

/** @deprecated Prefer buildOrganizzeMonthlyNets. */
export function buildPlannedMonthlyNets(params: {
  txs: ClassifiedTx[];
  installmentByMonth: Map<string, number>;
  fromYm: string;
  horizon: number;
  avgMonthlyIncomeCents?: number;
  primaryPct?: number;
}): number[] {
  return buildOrganizzeMonthlyNets(params);
}

/** Target from a single Organizze paycheck × primary %. */
export function weeklySaveTargetCents(
  paycheckCents: number,
  primaryPct: number,
): number {
  if (paycheckCents <= 0) {
    return 0;
  }
  return Math.round((paycheckCents * primaryPct) / 100);
}

/** Largest income launch in the month (typical paycheck when weekly). */
export function largestIncomeLaunchInMonth(
  txs: ClassifiedTx[],
  yearMonth: string,
): number {
  let max = 0;
  for (const tx of txs) {
    if (inMonth(tx.date, yearMonth) && isIncomeTx(tx)) {
      max = Math.max(max, tx.amountCents);
    }
  }
  return max;
}

/**
 * Remaining discretionary spend this month vs primary % of realized+scheduled
 * Organizze income for the month.
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

export type WealthGoalProjection = {
  points: ProjectionPoint[];
  goalEta: Map<string, string | null>;
};

/**
 * Single projection path for chart + goal ETAs.
 * Wealth follows Organizze monthly nets; positive surplus is allocated to active
 * goals by priority (virtual allocation — does not invent income).
 */
export function projectWealthAndGoals(params: {
  startYm: string;
  startWealthCents: number;
  startAllocatedCents: number;
  goals: GoalProgressInput[];
  monthlyNets: number[];
  horizon: number;
}): WealthGoalProjection {
  const active = params.goals
    .filter((g) => g.status === 'ACTIVE')
    .slice()
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const remaining = new Map(
    active.map((g) => [g.id, Math.max(0, g.targetCents - g.allocatedCents)]),
  );
  const goalEta = new Map<string, string | null>();
  for (const g of active) {
    if ((remaining.get(g.id) ?? 0) <= 0) {
      goalEta.set(g.id, params.startYm);
    }
  }

  let bookAllocated = Math.max(0, params.startAllocatedCents);

  const applyToGoals = (poolIn: number, ym: string): number => {
    let pool = Math.max(0, poolIn);
    for (const g of active) {
      const left = remaining.get(g.id) ?? 0;
      if (left <= 0 || pool <= 0) {
        continue;
      }
      let contribution = pool;
      if (
        g.monthlyContributionCents != null &&
        g.monthlyContributionCents > 0
      ) {
        contribution = Math.min(pool, g.monthlyContributionCents);
      } else if (
        g.monthlyContributionPct != null &&
        g.monthlyContributionPct > 0
      ) {
        contribution = Math.min(
          pool,
          Math.round((poolIn * g.monthlyContributionPct) / 100),
        );
      }
      const applied = Math.min(left, contribution);
      remaining.set(g.id, left - applied);
      bookAllocated += applied;
      pool -= applied;
      if ((remaining.get(g.id) ?? 0) <= 0 && !goalEta.has(g.id)) {
        goalEta.set(g.id, ym);
      }
    }
    return pool;
  };

  const points: ProjectionPoint[] = [];
  let wealth = params.startWealthCents;
  let freePool = Math.max(0, wealth - bookAllocated);

  freePool = applyToGoals(freePool, params.startYm);

  points.push({
    monthKey: params.startYm,
    netCents: 0,
    wealthCents: wealth,
    allocatedCents: bookAllocated,
    availableCents: Math.max(0, wealth - bookAllocated),
    scenario: 'base',
  });

  for (let i = 0; i < Math.max(0, params.horizon - 1); i += 1) {
    const net = params.monthlyNets[i] ?? 0;
    wealth += net;
    if (net > 0) {
      freePool += net;
    }
    const ym = shiftMonthKey(params.startYm, i + 1);
    freePool = applyToGoals(freePool, ym);
    points.push({
      monthKey: ym,
      netCents: net,
      wealthCents: wealth,
      allocatedCents: bookAllocated,
      availableCents: Math.max(0, wealth - bookAllocated),
      scenario: 'base',
    });
  }

  for (const g of active) {
    if (!goalEta.has(g.id)) {
      goalEta.set(g.id, null);
    }
  }

  return { points, goalEta };
}

export function projectWealth(params: {
  startYm: string;
  startWealthCents: number;
  startAllocatedCents: number;
  monthlyNets: number[];
  horizon: number;
}): ProjectionPoint[] {
  return projectWealthAndGoals({
    startYm: params.startYm,
    startWealthCents: params.startWealthCents,
    startAllocatedCents: params.startAllocatedCents,
    goals: [],
    monthlyNets: params.monthlyNets,
    horizon: params.horizon,
  }).points;
}
