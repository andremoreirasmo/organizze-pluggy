import {
  buildOrganizzeMonthlyNets,
  classifyOrganizzeTx,
  computePeriodSavings,
  cumulativePrimaryPaceBuffer,
  estimateGoalMonths,
  isTransferLike,
  monthsInclusive,
  periodSavingsFromCashflow,
  projectWealth,
  projectWealthAndGoals,
  requiredMonthlyForGoal,
  spendableThisMonthCents,
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

  it('does not double-count fatura when card purchase + invoice payment exist (tx fallback)', () => {
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
        paid_credit_card_id: 9,
      },
      cats,
      new Set(),
    );
    const faturaLabel = classifyOrganizzeTx(
      {
        id: 4,
        date: '2026-10-05',
        paid: false,
        amount_cents: -677_930,
        account_id: 1,
        credit_card_id: null,
        category_id: 2,
        description: 'Fatura Novembro 2026',
      },
      cats,
      new Set(),
    );
    expect(invoicePay.isInvoicePayment).toBe(true);
    expect(faturaLabel.isInvoicePayment).toBe(true);
    const period = computePeriodSavings(
      [income, cardPurchase, invoicePay, faturaLabel],
      { minPct: 30, primaryPct: 35, idealPct: 40 },
      () => true,
    );
    // Only the card purchase counts — invoice lines are excluded.
    expect(period.consumptionPaidCents).toBe(200_000);
    expect(period.savedCents).toBe(800_000);
  });

  it('builds period savings from Organizze /balances totals', () => {
    const period = periodSavingsFromCashflow(2_154_930, 1_338_775, {
      minPct: 20,
      primaryPct: 30,
      idealPct: 40,
    });
    expect(period.incomePaidCents).toBe(2_154_930);
    expect(period.consumptionPaidCents).toBe(1_338_775);
    expect(period.savedCents).toBe(2_154_930 - 1_338_775);
    expect(period.targetPrimaryCents).toBe(Math.round(2_154_930 * 0.3));
    expect(period.investmentContribPaidCents).toBe(0);
  });

  it('treats unpaid Organizze launches as efetivado', () => {
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

  it('counts investment contributions as expense in tx fallback', () => {
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
    expect(period.consumptionPaidCents).toBe(500_000);
    expect(period.investmentContribPaidCents).toBe(0);
    expect(period.savedCents).toBe(1_300_000);
    expect(period.targetPrimaryCents).toBe(630_000);
  });

  it('allows negative realized savings', () => {
    const cats = new Map<number, string>([[1, 'Salário']]);
    const period = computePeriodSavings(
      [
        classifyOrganizzeTx(
          {
            id: 1,
            date: '2026-10-01',
            paid: true,
            amount_cents: 100_000,
            account_id: 1,
            credit_card_id: null,
            category_id: 1,
          },
          cats,
          new Set(),
        ),
        classifyOrganizzeTx(
          {
            id: 2,
            date: '2026-10-02',
            paid: true,
            amount_cents: -250_000,
            account_id: 1,
            credit_card_id: null,
            category_id: 9,
          },
          cats,
          new Set(),
        ),
      ],
      { minPct: 30, primaryPct: 35, idealPct: 40 },
      () => true,
    );
    expect(period.savedCents).toBe(-150_000);
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
      0,
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
  });

  it('builds monthly nets only from Organizze launches (no invented income)', () => {
    const cats = new Map<number, string>([[1, 'Salário']]);
    const txs = [
      classifyOrganizzeTx(
        {
          id: 1,
          date: '2026-10-05',
          paid: true,
          amount_cents: 450_000,
          account_id: 1,
          credit_card_id: null,
          category_id: 1,
        },
        cats,
        new Set(),
      ),
      classifyOrganizzeTx(
        {
          id: 2,
          date: '2026-10-06',
          paid: true,
          amount_cents: -100_000,
          account_id: 1,
          credit_card_id: null,
          category_id: 9,
        },
        cats,
        new Set(),
      ),
      classifyOrganizzeTx(
        {
          id: 3,
          date: '2026-11-02',
          paid: false,
          amount_cents: 430_000,
          account_id: 1,
          credit_card_id: null,
          category_id: 1,
        },
        cats,
        new Set(),
      ),
    ];
    const nets = buildOrganizzeMonthlyNets({
      txs,
      installmentByMonth: new Map([['2026-12', 50_000]]),
      fromYm: '2026-10',
      horizon: 3,
    });
    expect(nets[0]).toBe(350_000);
    expect(nets[1]).toBe(430_000);
    // No Oz consumption in Dec → parcels only
    expect(nets[2]).toBe(-50_000);
    expect(weeklySaveTargetCents(450_000, 30)).toBe(135_000);
  });

  it('does not add parcels when month already has consumption txs', () => {
    const cats = new Map<number, string>([[1, 'Salário']]);
    const txs = [
      classifyOrganizzeTx(
        {
          id: 1,
          date: '2026-10-01',
          paid: true,
          amount_cents: 500_000,
          account_id: 1,
          credit_card_id: null,
          category_id: 1,
        },
        cats,
        new Set(),
      ),
      classifyOrganizzeTx(
        {
          id: 2,
          date: '2026-10-02',
          paid: true,
          amount_cents: -80_000,
          account_id: null,
          credit_card_id: 3,
          category_id: 9,
          description: 'Parcela loja',
        },
        cats,
        new Set(),
      ),
    ];
    const nets = buildOrganizzeMonthlyNets({
      txs,
      installmentByMonth: new Map([['2026-10', 80_000]]),
      fromYm: '2026-10',
      horizon: 1,
    });
    expect(nets[0]).toBe(420_000);
  });

  it('keeps goal ETA consistent with wealth projection available balance', () => {
    const goals = [
      {
        id: 'reserve',
        name: 'Reserva',
        targetCents: 5_000_000,
        allocatedCents: 5_000_000,
        targetDate: null,
        priority: 1,
        monthlyContributionCents: null,
        monthlyContributionPct: null,
        status: 'ACTIVE' as const,
      },
      {
        id: 'land',
        name: 'Terreno',
        targetCents: 10_000_000,
        allocatedCents: 0,
        targetDate: '2027-12-01',
        priority: 2,
        monthlyContributionCents: null,
        monthlyContributionPct: null,
        status: 'ACTIVE' as const,
      },
    ];
    const monthlyNets = Array.from({ length: 24 }, () => 800_000);
    const { points, goalEta } = projectWealthAndGoals({
      startYm: '2026-10',
      startWealthCents: 5_890_773,
      startAllocatedCents: 5_000_000,
      goals,
      monthlyNets,
      horizon: 24,
    });
    expect(goalEta.get('land')).toBeTruthy();
    const eta = goalEta.get('land')!;
    const atEta = points.find((p) => p.monthKey === eta);
    expect(atEta).toBeTruthy();
    // Emergency stays allocated; land reaches target without sharing that 50k.
    expect(atEta!.allocatedCents).toBeGreaterThanOrEqual(15_000_000);
    expect(atEta!.wealthCents).toBeGreaterThanOrEqual(atEta!.allocatedCents);
  });

  it('spendable this month is excess above primary % (no parcel double-count)', () => {
    const ahead = periodSavingsFromCashflow(1_000_000, 600_000, {
      minPct: 20,
      primaryPct: 30,
      idealPct: 40,
    });
    // saved 400k, target 300k → 100k room
    expect(ahead.savedCents).toBe(400_000);
    expect(ahead.targetPrimaryCents).toBe(300_000);
    expect(spendableThisMonthCents(ahead)).toBe(100_000);

    const behind = periodSavingsFromCashflow(1_000_000, 800_000, {
      minPct: 20,
      primaryPct: 30,
      idealPct: 40,
    });
    expect(spendableThisMonthCents(behind)).toBe(0);
  });

  it('accumulates primary % pace buffer across months (over/under compensate)', () => {
    // Month A: income 1000, expense 600 → saved 400, target 30%=300 → +100
    // Month B: income 1000, expense 800 → saved 200, target 300 → -100
    // Net buffer 0
    const even = cumulativePrimaryPaceBuffer({
      primaryPct: 30,
      months: [
        { incomeCents: 1_000_000, expenseCents: 600_000 },
        { incomeCents: 1_000_000, expenseCents: 800_000 },
      ],
    });
    expect(even.savedCents).toBe(600_000);
    expect(even.targetSaveCents).toBe(600_000);
    expect(even.bufferCents).toBe(0);
    expect(even.savedPct).toBeCloseTo(30, 5);

    const ahead = cumulativePrimaryPaceBuffer({
      primaryPct: 30,
      months: [
        { incomeCents: 1_000_000, expenseCents: 500_000 },
        { incomeCents: 1_000_000, expenseCents: 700_000 },
      ],
    });
    // saved 800k, target 600k → +200k folga
    expect(ahead.bufferCents).toBe(200_000);

    const behind = cumulativePrimaryPaceBuffer({
      primaryPct: 30,
      months: [
        { incomeCents: 2_000_000, expenseCents: 1_800_000 },
        { incomeCents: 1_000_000, expenseCents: 900_000 },
      ],
    });
    // saved 300k, target 900k → -600k falta
    expect(behind.bufferCents).toBe(-600_000);
    expect(behind.monthsWithIncome).toBe(2);
    expect(behind.windowMonths).toBe(2);
  });
});
