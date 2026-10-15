import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomRecurringKind,
  CustomRecurringOccurrenceStatus,
  CustomRecurringStatus,
  CustomRecurringUnit,
  Prisma,
} from '@prisma/client';
import { normalizeOrganizzeTagNames } from '../organizze/organizze-tags';
import { OrganizzeService } from '../organizze/organizze.service';
import { PrismaService } from '../prisma/prisma.module';
import {
  generateOccurrenceDates,
  parseIsoDateOnly,
  signedAmountCents,
  toIsoDateOnly,
} from './custom-recurring.dates';
import {
  buildCustomRecurringMarker,
  parseCustomRecurringMarker,
} from './custom-recurring.notes';
import type {
  CreateCustomRecurringBody,
  CustomRecurringOccurrenceDto,
  CustomRecurringSeriesDetailDto,
  CustomRecurringSeriesSummaryDto,
  PreviewCustomRecurringBody,
  UpdateCustomRecurringBody,
} from './custom-recurring.types';

type SeriesWithOcc = Prisma.CustomRecurringSeriesGetPayload<{
  include: { occurrences: true };
}>;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function tagsFromJson(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Organizze ids fit JS number / PG BIGINT, not PG INTEGER. */
function toOrganizzeIdBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      throw new Error(`Invalid Organizze transaction id: ${value}`);
    }
    return value;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid Organizze transaction id: ${String(value)}`);
  }
  return BigInt(n);
}

function toOrganizzeIdNumber(value: bigint | number | null): number | null {
  if (value == null) {
    return null;
  }
  return Number(value);
}

@Injectable()
export class CustomRecurringService {
  private readonly logger = new Logger(CustomRecurringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizze: OrganizzeService,
  ) {}

  preview(body: PreviewCustomRecurringBody): {
    count: number;
    totalAmountCents: number;
    dates: string[];
  } {
    const dates = this.safeGenerateDates(body);
    const per = Math.abs(Math.round(body.amountCents));
    return {
      count: dates.length,
      totalAmountCents: per * dates.length,
      dates,
    };
  }

  async list(): Promise<CustomRecurringSeriesSummaryDto[]> {
    this.requireDb();
    const rows = await this.prisma.customRecurringSeries.findMany({
      where: { status: CustomRecurringStatus.ACTIVE },
      include: { occurrences: true },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async get(id: string): Promise<CustomRecurringSeriesDetailDto> {
    this.requireDb();
    const row = await this.prisma.customRecurringSeries.findUnique({
      where: { id },
      include: { occurrences: { orderBy: { index: 'asc' } } },
    });
    if (!row || row.status === CustomRecurringStatus.CANCELLED) {
      throw new NotFoundException(`Series ${id} not found`);
    }
    return this.toDetail(row);
  }

  async create(
    body: CreateCustomRecurringBody,
  ): Promise<CustomRecurringSeriesDetailDto> {
    this.requireDb();
    const description = body.description.trim();
    if (!description) {
      throw new BadRequestException('description is required');
    }
    const amountCents = Math.abs(Math.round(body.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    if (!Number.isFinite(body.accountId) || body.accountId <= 0) {
      throw new BadRequestException('accountId is required');
    }
    await this.assertAccount(body.accountId);

    const dates = this.safeGenerateDates(body);
    const tags = normalizeOrganizzeTagNames(body.tags) ?? [];
    const tagNames = tags.map((tag) => tag.name);
    const kind =
      body.kind === 'INCOME'
        ? CustomRecurringKind.INCOME
        : CustomRecurringKind.EXPENSE;
    const unit = this.toUnit(body.intervalUnit);

    const series = await this.prisma.customRecurringSeries.create({
      data: {
        kind,
        description,
        amountCents,
        accountId: body.accountId,
        categoryId: body.categoryId ?? null,
        tags: tagNames,
        startDate: parseIsoDateOnly(body.startDate),
        endDate: parseIsoDateOnly(body.endDate),
        intervalUnit: unit,
        intervalCount: body.intervalCount,
        occurrences: {
          create: dates.map((date, index) => ({
            index,
            scheduledDate: parseIsoDateOnly(date),
            amountCents,
            status: CustomRecurringOccurrenceStatus.PENDING,
          })),
        },
      },
      include: { occurrences: { orderBy: { index: 'asc' } } },
    });

    await this.createOrganizzeForPending(series.id);
    return this.get(series.id);
  }

  async update(
    id: string,
    body: UpdateCustomRecurringBody,
  ): Promise<CustomRecurringSeriesDetailDto> {
    this.requireDb();
    const current = await this.prisma.customRecurringSeries.findUnique({
      where: { id },
      include: { occurrences: { orderBy: { index: 'asc' } } },
    });
    if (!current || current.status === CustomRecurringStatus.CANCELLED) {
      throw new NotFoundException(`Series ${id} not found`);
    }

    const startDate = toIsoDateOnly(current.startDate);
    const nextEnd = body.endDate;
    if (nextEnd < startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    const desiredDates = this.safeGenerateDates({
      startDate,
      endDate: nextEnd,
      intervalUnit: current.intervalUnit,
      intervalCount: current.intervalCount,
    });
    const desiredSet = new Set(desiredDates);
    const existingDates = new Set(
      current.occurrences.map((occ) => toIsoDateOnly(occ.scheduledDate)),
    );

    // Trim: drop occurrences beyond the new end (and their Oz txs).
    for (const occ of current.occurrences) {
      const date = toIsoDateOnly(occ.scheduledDate);
      if (desiredSet.has(date)) {
        continue;
      }
      const ozId = toOrganizzeIdNumber(occ.organizzeTransactionId);
      if (
        ozId != null &&
        occ.status === CustomRecurringOccurrenceStatus.CREATED
      ) {
        try {
          await this.organizze.deleteTransaction(ozId);
        } catch (error) {
          this.logger.warn(
            `deleteTransaction(${ozId}) on trim failed: ${String(error)}`,
          );
        }
      }
      await this.prisma.customRecurringOccurrence.delete({
        where: { id: occ.id },
      });
      existingDates.delete(date);
    }

    // Extend: append missing dates with contiguous indices.
    const remaining = await this.prisma.customRecurringOccurrence.findMany({
      where: { seriesId: id },
      orderBy: { index: 'asc' },
    });
    let nextIndex =
      remaining.reduce((max, occ) => Math.max(max, occ.index), -1) + 1;
    const toCreate = desiredDates.filter((date) => !existingDates.has(date));
    if (toCreate.length > 0) {
      await this.prisma.customRecurringOccurrence.createMany({
        data: toCreate.map((date) => {
          const index = nextIndex;
          nextIndex += 1;
          return {
            seriesId: id,
            index,
            scheduledDate: parseIsoDateOnly(date),
            amountCents: current.amountCents,
            status: CustomRecurringOccurrenceStatus.PENDING,
          };
        }),
      });
    }

    await this.prisma.customRecurringSeries.update({
      where: { id },
      data: { endDate: parseIsoDateOnly(nextEnd) },
    });

    await this.createOrganizzeForPending(id);
    return this.get(id);
  }

  async retryFailed(id: string): Promise<CustomRecurringSeriesDetailDto> {
    this.requireDb();
    const series = await this.prisma.customRecurringSeries.findUnique({
      where: { id },
    });
    if (!series || series.status === CustomRecurringStatus.CANCELLED) {
      throw new NotFoundException(`Series ${id} not found`);
    }
    await this.createOrganizzeForPending(id);
    return this.get(id);
  }

  async remove(id: string): Promise<{ ok: true }> {
    this.requireDb();
    const series = await this.prisma.customRecurringSeries.findUnique({
      where: { id },
      include: { occurrences: true },
    });
    if (!series) {
      throw new NotFoundException(`Series ${id} not found`);
    }
    const today = todayIso();
    for (const occ of series.occurrences) {
      const date = toIsoDateOnly(occ.scheduledDate);
      const ozId = toOrganizzeIdNumber(occ.organizzeTransactionId);
      if (
        date >= today &&
        ozId != null &&
        occ.status === CustomRecurringOccurrenceStatus.CREATED
      ) {
        try {
          await this.organizze.deleteTransaction(ozId);
        } catch (error) {
          this.logger.warn(
            `deleteTransaction(${ozId}) failed: ${String(error)}`,
          );
        }
      }
    }
    await this.prisma.customRecurringSeries.update({
      where: { id },
      data: { status: CustomRecurringStatus.CANCELLED },
    });
    await this.prisma.customRecurringOccurrence.deleteMany({
      where: {
        seriesId: id,
        scheduledDate: { gte: parseIsoDateOnly(today) },
      },
    });
    return { ok: true };
  }

  private async createOrganizzeForPending(seriesId: string): Promise<void> {
    const series = await this.prisma.customRecurringSeries.findUniqueOrThrow({
      where: { id: seriesId },
      include: {
        occurrences: {
          where: {
            status: {
              in: [
                CustomRecurringOccurrenceStatus.PENDING,
                CustomRecurringOccurrenceStatus.FAILED,
              ],
            },
          },
          orderBy: { index: 'asc' },
        },
      },
    });
    if (series.occurrences.length === 0) {
      return;
    }
    const today = todayIso();
    const tags = normalizeOrganizzeTagNames(tagsFromJson(series.tags));
    const existingByIndex = await this.findExistingOrganizzeByMarker(series);
    for (const occ of series.occurrences) {
      const date = toIsoDateOnly(occ.scheduledDate);
      try {
        const existingId = existingByIndex.get(occ.index);
        const ozId =
          existingId ??
          (await this.organizze
            .createTransaction({
              description: series.description,
              date,
              amount_cents: signedAmountCents(series.kind, series.amountCents),
              paid: date <= today,
              account_id: series.accountId,
              category_id: series.categoryId,
              notes: buildCustomRecurringMarker(series.id, occ.index),
              ...(tags ? { tags } : {}),
            })
            .then((created) => created.id));
        await this.prisma.customRecurringOccurrence.update({
          where: { id: occ.id },
          data: {
            status: CustomRecurringOccurrenceStatus.CREATED,
            organizzeTransactionId: toOrganizzeIdBigInt(ozId),
            lastError: null,
            amountCents: series.amountCents,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `create occurrence ${seriesId}#${occ.index} failed: ${message}`,
        );
        await this.prisma.customRecurringOccurrence.update({
          where: { id: occ.id },
          data: {
            status: CustomRecurringOccurrenceStatus.FAILED,
            lastError: message.slice(0, 500),
          },
        });
      }
    }
  }

  private async findExistingOrganizzeByMarker(series: {
    id: string;
    startDate: Date;
    endDate: Date;
  }): Promise<Map<number, number>> {
    const startDate = toIsoDateOnly(series.startDate);
    const endDate = toIsoDateOnly(series.endDate);
    const txs = await this.organizze.listTransactions({ startDate, endDate });
    const byIndex = new Map<number, number>();
    for (const tx of txs) {
      const parsed = parseCustomRecurringMarker(tx.notes);
      if (!parsed || parsed.seriesId !== series.id) {
        continue;
      }
      byIndex.set(parsed.index, tx.id);
    }
    return byIndex;
  }

  private safeGenerateDates(body: {
    startDate: string;
    endDate: string;
    intervalCount: number;
    intervalUnit: string;
  }): string[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      throw new BadRequestException('startDate must be YYYY-MM-DD');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) {
      throw new BadRequestException('endDate must be YYYY-MM-DD');
    }
    if (!Number.isFinite(body.intervalCount) || body.intervalCount < 1) {
      throw new BadRequestException('intervalCount must be >= 1');
    }
    try {
      return generateOccurrenceDates({
        startDateIso: body.startDate,
        endDateIso: body.endDate,
        intervalCount: Math.floor(body.intervalCount),
        intervalUnit: this.toUnit(body.intervalUnit),
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private toUnit(unit: string): CustomRecurringUnit {
    if (unit === 'DAY') return CustomRecurringUnit.DAY;
    if (unit === 'WEEK') return CustomRecurringUnit.WEEK;
    if (unit === 'MONTH') return CustomRecurringUnit.MONTH;
    throw new BadRequestException('intervalUnit must be DAY, WEEK or MONTH');
  }

  private async assertAccount(accountId: number): Promise<void> {
    const accounts = await this.organizze.listAccounts({
      includeArchived: false,
    });
    if (!accounts.some((account) => account.id === accountId)) {
      throw new BadRequestException(
        `Organizze account ${accountId} not found`,
      );
    }
  }

  private requireDb(): void {
    if (!this.prisma.isEnabled()) {
      throw new BadRequestException('Database is not configured');
    }
  }

  private toSummary(row: SeriesWithOcc): CustomRecurringSeriesSummaryDto {
    const createdCount = row.occurrences.filter(
      (occ) => occ.status === CustomRecurringOccurrenceStatus.CREATED,
    ).length;
    const failedCount = row.occurrences.filter(
      (occ) => occ.status === CustomRecurringOccurrenceStatus.FAILED,
    ).length;
    const totalCount = row.occurrences.length;
    return {
      id: row.id,
      kind: row.kind,
      description: row.description,
      amountCents: row.amountCents,
      accountId: row.accountId,
      categoryId: row.categoryId,
      tags: tagsFromJson(row.tags),
      startDate: toIsoDateOnly(row.startDate),
      endDate: toIsoDateOnly(row.endDate),
      intervalUnit: row.intervalUnit,
      intervalCount: row.intervalCount,
      status: row.status,
      createdCount,
      failedCount,
      totalCount,
      totalAmountCents: row.amountCents * totalCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetail(row: SeriesWithOcc): CustomRecurringSeriesDetailDto {
    const occurrences: CustomRecurringOccurrenceDto[] = row.occurrences
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((occ) => ({
        id: occ.id,
        index: occ.index,
        scheduledDate: toIsoDateOnly(occ.scheduledDate),
        amountCents: occ.amountCents,
        organizzeTransactionId: toOrganizzeIdNumber(occ.organizzeTransactionId),
        status: occ.status,
        lastError: occ.lastError,
      }));
    return {
      ...this.toSummary(row),
      occurrences,
    };
  }
}
