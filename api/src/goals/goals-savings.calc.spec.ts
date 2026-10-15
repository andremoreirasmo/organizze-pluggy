import {
  buildPlannedMonthlyNets,
  classifyOrganizzeTx,
  computePeriodSavings,
  estimateAverageMonthlyIncome,
  estimateGoalMonths,
  isTransferLike,
  monthsInclusive,
  projectWealth,
  requiredMonthlyForGoal,
  toGoalProgress,
  weeklySaveTargetCents,
} from './goals-savings.calc';

describe('goals-savings.calc', () => {
  it('does not treat transfers as income or expense', () => {
    expect(
      isTransferLike({ oposite_transaction_id: 1, oposite_account_id: null }),
    ).toBe(true);
    const cats = new Map<number, string>([[10, 'Salário']]);
    const transfer = classifyOrganizzeTx(
      {
        id: 1,
        date: '2026-10-01',
        paid: true,
        amount_cents: 50000,
        account_id: 1,
        credit_card_id: null,
        category_id: 10,
        oposite_transaction_id: 99,
        oposite_account_id: 2,
      },
      cats,
      new Set(),
    );
    const period = computePeriodSavings(
      [transfer],
      { minPct: 30, primaryPct: 35, idealPct: 40 },
      () => true,
    );
    expect(period.incomePaidCents).toBe(0);
    expect(period.savedCents).toBe(0);
  });

  it('excludes credit-card invoice payments from consumption', () => {
    const cats = new Map<number, string>([
      [1, 'Salário'],
      [2, 'Pagamento de fatura'],
      [3, 'Mercado'],
    ]);
    const income = classifyOrganizzeTx(
      {
        id: 1,
        date: '2026-10-05',
        paid: true,
        amount_cents: 1_000_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 1,
      },
      cats,
      new Set(),
    );
    const cardPurchase = classifyOrganizzeTx(
      {
        id: 2,
        date: '2026-10-06',
        paid: true,
        amount_cents: -200_000,
        account_id: null,
        credit_card_id: 9,
        category_id: 3,
        description: 'Supermercado',
      },
      cats,
      new Set(),
    );
    const invoicePay = classifyOrganizzeTx(
      {
        id: 3,
        date: '2026-10-10',
        paid: true,
        amount_cents: -200_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 2,
        description: 'Pagamento de fatura',
      },
      cats,
      new Set(),
    );
    expect(invoicePay.isInvoicePayment).toBe(true);
    const period = computePeriodSavings(
      [income, cardPurchase, invoicePay],
      { minPct: 30, primaryPct: 35, idealPct: 40 },
      () => true,
    );
    expect(period.consumptionPaidCents).toBe(200_000);
    expect(period.savedCents).toBe(800_000);
  });

  it('counts unpaid launches as efetivado for analysis', () => {
    const cats = new Map<number, string>([[1, 'Salário']]);
    const unpaidIncome = classifyOrganizzeTx(
      {
        id: 1,
        date: '2026-10-20',
        paid: false,
        amount_cents: 450_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 1,
      },
      cats,
      new Set(),
    );
    const unpaidExpense = classifyOrganizzeTx(
      {
        id: 2,
        date: '2026-10-21',
        paid: false,
        amount_cents: -80_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 99,
      },
      cats,
      new Set(),
    );
    const period = computePeriodSavings(
      [unpaidIncome, unpaidExpense],
      { minPct: 30, primaryPct: 35, idealPct: 40 },
      () => true,
    );
    expect(period.incomePaidCents).toBe(450_000);
    expect(period.incomePlannedCents).toBe(0);
    expect(period.consumptionPaidCents).toBe(80_000);
    expect(period.savedCents).toBe(370_000);
  });

  it('counts investment contribution as savings, not consumption', () => {
    const cats = new Map<number, string>([
      [1, 'Salário'],
      [2, 'Aplicação CDB'],
    ]);
    const income = classifyOrganizzeTx(
      {
        id: 1,
        date: '2026-10-05',
        paid: true,
        amount_cents: 1_800_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 1,
      },
      cats,
      new Set(),
    );
    const aporte = classifyOrganizzeTx(
      {
        id: 2,
        date: '2026-10-06',
        paid: true,
        amount_cents: -400_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 2,
      },
      cats,
      new Set(),
    );
    const grocery = classifyOrganizzeTx(
      {
        id: 3,
        date: '2026-10-07',
        paid: true,
        amount_cents: -100_000,
        account_id: 1,
        credit_card_id: null,
        category_id: 99,
      },
      cats,
      new Set(),
    );
    const period = computePeriodSavings(
      [income, aporte, grocery],
      { minPct: 30, primaryPct: 35, idealPct: 40 },
      () => true,
    );
    expect(period.incomePaidCents).toBe(1_800_000);
    expect(period.consumptionPaidCents).toBe(100_000);
    expect(period.investmentContribPaidCents).toBe(400_000);
    expect(period.savedCents).toBe(2_100_000);
    expect(period.targetPrimaryCents).toBe(630_000);
  });

  it('allocates goals without double-counting capital', () => {
    const goals = [
      {
        id: 'a',
        name: 'Emergência',
        targetCents: 5_000_000,
        allocatedCents: 5_000_000,
        targetDate: null,
        priority: 1,
        monthlyContributionCents: null,
        monthlyContributionPct: null,
        status: 'ACTIVE' as const,
      },
      {
        id: 'b',
        name: 'Terreno',
        targetCents: 10_000_000,
        allocatedCents: 10_000_000,
        targetDate: '2027-12-01',
        priority: 2,
        monthlyContributionCents: null,
        monthlyContributionPct: null,
        status: 'ACTIVE' as const,
      },
    ];
    const etas = estimateGoalMonths({
      goals,
      monthlySpareCents: 100_000,
      startYm: '2026-10',
      horizonMonths: 12,
    });
    expect(etas.get('a')).toBe('2026-10');
    expect(etas.get('b')).toBe('2026-10');
    const views = goals.map((g) =>
      toGoalProgress(g, etas.get(g.id) ?? null, '2026-10', 100_000),
    );
    expect(views.every((v) => v.pace === 'done')).toBe(true);
    expect(views.reduce((s, v) => s + v.allocatedCents, 0)).toBe(15_000_000);
  });

  it('computes required monthly from today through target month', () => {
    expect(monthsInclusive('2026-10', '2027-12')).toBe(15);
    expect(requiredMonthlyForGoal(1_500_000, 15)).toBe(100_000);
    const required = Math.ceil(10_000_000 / 15);
    const behind = toGoalProgress(
      {
        id: 't',
        name: 'Terreno',
        targetCents: 10_000_000,
        allocatedCents: 0,
        targetDate: '2027-12-15',
        priority: 1,
        monthlyContributionCents: null,
        monthlyContributionPct: null,
        status: 'ACTIVE',
      },
      null,
      '2026-10',
      0,
    );
    expect(behind.monthsRemaining).toBe(15);
    expect(behind.requiredMonthlyCents).toBe(required);
    expect(behind.pace).toBe('behind');

    const onTrack = toGoalProgress(
      {
        id: 't',
        name: 'Terreno',
        targetCents: 10_000_000,
        allocatedCents: 0,
        targetDate: '2027-12-15',
        priority: 1,
        monthlyContributionCents: null,
        monthlyContributionPct: null,
        status: 'ACTIVE',
      },
      '2027-12',
      '2026-10',
      required,
    );
    expect(onTrack.pace).toBe('on_track');
  });

  it('projects wealth starting at current net worth', () => {
    const points = projectWealth({
      startYm: '2026-11',
      startWealthCents: 100_000,
      startAllocatedCents: 40_000,
      monthlyNets: [10_000, -5_000, 20_000],
      horizon: 3,
    });
    expect(points).toHaveLength(3);
    expect(points[0].monthKey).toBe('2026-11');
    expect(points[0].wealthCents).toBe(100_000);
    expect(points[1].wealthCents).toBe(110_000);
    expect(points[2].wealthCents).toBe(105_000);
    expect(points[2].availableCents).toBe(65_000);
  });

  it('plans monthly nets from primary % of average income', () => {
    const cats = new Map<number, string>([[1, 'Salário']]);
    const txs = [8, 9].flatMap((month, idx) => [
      classifyOrganizzeTx(
        {
          id: idx * 2 + 1,
          date: `2026-0${month}-05`,
          paid: true,
          amount_cents: 1_800_000,
          account_id: 1,
          credit_card_id: null,
          category_id: 1,
        },
        cats,
        new Set(),
      ),
    ]);
    const avg = estimateAverageMonthlyIncome(txs, '2026-10', 3);
    expect(avg).toBe(1_800_000);
    const nets = buildPlannedMonthlyNets({
      txs,
      installmentByMonth: new Map([['2026-10', 50_000]]),
      fromYm: '2026-10',
      horizon: 3,
      avgMonthlyIncomeCents: avg,
      primaryPct: 35,
    });
    // Parcels within spend budget do not reduce the planned 35% save.
    expect(nets[0]).toBe(630_000);
    expect(nets[1]).toBe(630_000);
    expect(nets[2]).toBe(630_000);
    expect(weeklySaveTargetCents(1_800_000, 35)).toBe(
      Math.round(630_000 / (52 / 12)),
    );
  });

  it('keeps projection flat when there is no income baseline', () => {
    const nets = buildPlannedMonthlyNets({
      txs: [],
      installmentByMonth: new Map([['2026-10', 200_000]]),
      fromYm: '2026-10',
      horizon: 4,
      avgMonthlyIncomeCents: 0,
      primaryPct: 35,
    });
    expect(nets).toEqual([0, 0, 0, 0]);
  });

  it('applies free cash before monthly contributions on goal ETA', () => {
    const etas = estimateGoalMonths({
      goals: [
        {
          id: 'land',
          name: 'Terreno',
          targetCents: 1_000_000,
          allocatedCents: 0,
          targetDate: '2027-12-01',
          priority: 1,
          monthlyContributionCents: null,
          monthlyContributionPct: null,
          status: 'ACTIVE',
        },
      ],
      monthlySpareCents: 100_000,
      startYm: '2026-10',
      horizonMonths: 24,
      initialBonusCents: 900_000,
    });
    expect(etas.get('land')).toBe('2026-10');
  });
});
