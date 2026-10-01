import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from './settings.types';

const SETTINGS_ID = 'default';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private requireDatabase(): void {
    if (!this.prisma.isEnabled()) {
      throw new ServiceUnavailableException(
        'DATABASE_URL is not configured. Settings require Neon Postgres.',
      );
    }
  }

  async getSettings(): Promise<AppSettings> {
    this.requireDatabase();
    const row = await this.prisma.setting.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (!row) {
      return {
        ...DEFAULT_APP_SETTINGS,
        accountMaps: [],
        balanceMaps: [],
        ignoredInstallmentKeys: [],
      };
    }
    return normalizeAppSettings(row.data);
  }

  async updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    this.requireDatabase();
    const current = await this.getSettings();
    const merged = normalizeAppSettings({
      ...current,
      ...input,
      accountMaps:
        input.accountMaps !== undefined ? input.accountMaps : current.accountMaps,
      balanceMaps:
        input.balanceMaps !== undefined ? input.balanceMaps : current.balanceMaps,
      ignoredInstallmentKeys:
        input.ignoredInstallmentKeys !== undefined
          ? input.ignoredInstallmentKeys
          : current.ignoredInstallmentKeys,
    });

    if (
      merged.amountTolerancePercent < 0 ||
      merged.amountTolerancePercent > 50
    ) {
      throw new BadRequestException(
        'amountTolerancePercent must be between 0 and 50',
      );
    }
    if (merged.dateToleranceDays < 0 || merged.dateToleranceDays > 30) {
      throw new BadRequestException('dateToleranceDays must be between 0 and 30');
    }

    const seenAccounts = new Set<string>();
    for (const map of merged.accountMaps) {
      if (seenAccounts.has(map.pluggyAccountId)) {
        throw new BadRequestException(
          `Duplicate mapping for Pluggy account ${map.pluggyAccountId}`,
        );
      }
      seenAccounts.add(map.pluggyAccountId);
    }

    const seenBalance = new Set<string>();
    for (const map of merged.balanceMaps) {
      if (seenBalance.has(map.sourceKey)) {
        throw new BadRequestException(
          `Duplicate balance mapping for ${map.sourceKey}`,
        );
      }
      seenBalance.add(map.sourceKey);
    }

    await this.prisma.setting.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        data: merged as unknown as Prisma.InputJsonValue,
      },
      update: {
        data: merged as unknown as Prisma.InputJsonValue,
      },
    });

    return merged;
  }
}
