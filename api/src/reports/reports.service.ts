import { Injectable } from '@nestjs/common';
import { OrganizzeService } from '../organizze/organizze.service';
import type {
  CashflowMonthPoint,
  ReportsCashflowOverviewDto,
} from './reports.types';

function currentMonthKeySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('pt-BR', {
      month: 'short',
      timeZone: 'UTC',
    })
    .replace('.', '');
}

@Injectable()
export class ReportsService {
  constructor(private readonly organizze: OrganizzeService) {}

  async getCashflowOverview(
    monthKey?: string,
  ): Promise<ReportsCashflowOverviewDto> {
    const selectedMonth =
      monthKey && /^\d{4}-\d{2}$/.test(monthKey)
        ? monthKey
        : currentMonthKeySaoPaulo();
    const year = Number(selectedMonth.slice(0, 4));
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const series = await this.organizze.getMonthlyCashflowSeries({
      startDate,
      endDate,
    });

    const months: CashflowMonthPoint[] = [];
    for (let month = 1; month <= 12; month += 1) {
      const ym = `${year}-${String(month).padStart(2, '0')}`;
      const row = series.get(ym);
      const incomeCents = row?.incomeCents ?? 0;
      const expenseCents = row?.expenseCents ?? 0;
      months.push({
        monthKey: ym,
        label: monthLabel(ym),
        incomeCents,
        expenseCents,
        leftoverCents: incomeCents - expenseCents,
      });
    }

    const yearTotals = months.reduce(
      (acc, m) => ({
        incomeCents: acc.incomeCents + m.incomeCents,
        expenseCents: acc.expenseCents + m.expenseCents,
        leftoverCents: acc.leftoverCents + m.leftoverCents,
      }),
      { incomeCents: 0, expenseCents: 0, leftoverCents: 0 },
    );

    return {
      generatedAt: new Date().toISOString(),
      selectedMonth,
      year,
      months,
      yearTotals,
      note: 'Valores do /balances do Organizze (receita e despesa previstas por conta). Sem somar lançamentos.',
    };
  }
}
