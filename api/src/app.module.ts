import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { OriginCheckGuard } from './auth/origin-check.guard';
import { SessionAuthGuard } from './auth/session-auth.guard';
import { HealthModule } from './health/health.module';
import { OrganizzeModule } from './organizze/organizze.module';
import { PluggyModule } from './pluggy/pluggy.module';
import { PrismaModule } from './prisma/prisma.module';
import { InstitutionModule } from './institution/institution.module';
import { SettingsModule } from './settings/settings.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { BalancesModule } from './balances/balances.module';
import { InvestmentsModule } from './investments/investments.module';
import { InstallmentsModule } from './installments/installments.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    AuthModule,
    HealthModule,
    PrismaModule,
    InstitutionModule,
    OrganizzeModule,
    PluggyModule,
    SettingsModule,
    ReconciliationModule,
    BalancesModule,
    InvestmentsModule,
    InstallmentsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: OriginCheckGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SessionAuthGuard,
    },
  ],
})
export class AppModule {}
