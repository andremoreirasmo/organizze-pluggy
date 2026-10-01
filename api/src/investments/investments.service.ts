import { Injectable } from '@nestjs/common';
import {
  PluggyInvestmentView,
  PluggyService,
} from '../pluggy/pluggy.service';
import type {
  InvestmentAllocationBucket,
  InvestmentAllocationSlice,
  InvestmentConnectionFilter,
  InvestmentMaturityItem,
  InvestmentOverviewItem,
  InvestmentsOverviewResponse,
} from './investments.types';

const BUCKET_LABELS: Record<InvestmentAllocationBucket, string> = {
  fixed_income: 'Renda Fixa',
  stocks: 'Ações',
  fiis: 'FIIs',
  funds: 'Fundos',
  etf: 'ETF',
  other: 'Outros',
};

const BUCKET_ORDER: InvestmentAllocationBucket[] = [
  'fixed_income',
  'stocks',
  'fiis',
  'funds',
  'etf',
  'other',
];

function toCents(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Math.round(value * 100);
}

export function classifyInvestmentBucket(
  type: string,
  subtype: string | null,
): InvestmentAllocationBucket {
  const t = (type ?? '').toUpperCase();
  const s = (subtype ?? '').toUpperCase();
  if (t === 'FIXED_INCOME') {
    return 'fixed_income';
  }
  if (t === 'MUTUAL_FUND') {
    return 'funds';
  }
  if (t === 'ETF' || s === 'ETF') {
    return 'etf';
  }
  if (s === 'REAL_ESTATE_FUND') {
    return 'fiis';
  }
  if (t === 'EQUITY') {
    return 'stocks';
  }
  if (t === 'SECURITY' || t === 'COE' || t === 'OTHER') {
    return 'other';
  }
  return 'other';
}

@Injectable()
export class InvestmentsService {
  constructor(private readonly pluggy: PluggyService) {}

  async getOverview(): Promise<InvestmentsOverviewResponse> {
    const investments = await this.pluggy.listInvestments();
    return this.buildOverview(investments);
  }

  buildOverview(
    investments: PluggyInvestmentView[],
  ): InvestmentsOverviewResponse {
    const totalBalanceCents = investments.reduce(
      (sum, item) => sum + item.balanceCents,
      0,
    );

    let profitSum = 0;
    let profitCount = 0;
    for (const item of investments) {
      const profit = toCents(item.amountProfit);
      if (profit != null) {
        profitSum += profit;
        profitCount += 1;
      }
    }

    const byBucket = new Map<InvestmentAllocationBucket, number>();
    for (const bucket of BUCKET_ORDER) {
      byBucket.set(bucket, 0);
    }
    for (const item of investments) {
      const bucket = classifyInvestmentBucket(item.type, item.subtype);
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + item.balanceCents);
    }

    const allocation: InvestmentAllocationSlice[] = BUCKET_ORDER.map(
      (bucket) => {
        const balanceCents = byBucket.get(bucket) ?? 0;
        return {
          bucket,
          label: BUCKET_LABELS[bucket],
          balanceCents,
          percent:
            totalBalanceCents > 0
              ? Math.round((balanceCents / totalBalanceCents) * 1000) / 10
              : 0,
        };
      },
    ).filter((slice) => slice.balanceCents > 0);

    const connectionMap = new Map<string, InvestmentConnectionFilter>();
    for (const item of investments) {
      const id = item.connectionId ?? item.itemId;
      const existing = connectionMap.get(id);
      if (existing) {
        existing.balanceCents += item.balanceCents;
        continue;
      }
      connectionMap.set(id, {
        id,
        name: item.connectionName ?? 'Conexão',
        imageUrl: item.connectionImageUrl,
        primaryColor: item.connectionPrimaryColor,
        balanceCents: item.balanceCents,
      });
    }

    const maturities: InvestmentMaturityItem[] = investments
      .filter(
        (item) =>
          item.type.toUpperCase() === 'FIXED_INCOME' &&
          typeof item.dueDate === 'string' &&
          item.dueDate.length > 0,
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        subtype: item.subtype,
        dueDate: item.dueDate as string,
        balanceCents: item.balanceCents,
        connectionName: item.connectionName,
      }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const items: InvestmentOverviewItem[] = investments.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      subtype: item.subtype,
      balanceCents: item.balanceCents,
      amountProfitCents: toCents(item.amountProfit),
      dueDate: item.dueDate,
      connectionId: item.connectionId,
      connectionName: item.connectionName,
      bucket: classifyInvestmentBucket(item.type, item.subtype),
    }));

    return {
      generatedAt: new Date().toISOString(),
      totalBalanceCents,
      totalProfitCents: profitCount > 0 ? profitSum : null,
      allocation:
        allocation.length > 0
          ? allocation
          : [
              {
                bucket: 'other',
                label: BUCKET_LABELS.other,
                balanceCents: 0,
                percent: 0,
              },
            ],
      connections: [...connectionMap.values()].sort((a, b) =>
        a.name.localeCompare(b.name, 'pt-BR'),
      ),
      maturities,
      nextMaturityDate: maturities[0]?.dueDate ?? null,
      items,
    };
  }
}
