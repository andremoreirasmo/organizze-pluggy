import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Module, Global } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly enabled: boolean;

  constructor() {
    const databaseUrl =
      process.env.DATABASE_URL ??
      'postgresql://unused:unused@127.0.0.1:5432/unused?schema=public';
    super({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });
    this.enabled = Boolean(process.env.DATABASE_URL);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'DATABASE_URL not set — Prisma disabled until Neon is configured',
      );
      return;
    }
    await this.$connect();
  }

  async onModuleDestroy() {
    if (this.enabled) {
      await this.$disconnect();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
