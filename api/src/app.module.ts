import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { BasicAuthGuard } from './auth/basic-auth.guard';
import { HealthModule } from './health/health.module';
import { OrganizzeModule } from './organizze/organizze.module';
import { PluggyModule } from './pluggy/pluggy.module';
import { PrismaModule } from './prisma/prisma.module';
import { InstitutionModule } from './institution/institution.module';
import { SettingsModule } from './settings/settings.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { BalancesModule } from './balances/balances.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      validate: validateEnv,
    }),
    AuthModule,
    HealthModule,
    PrismaModule,
    InstitutionModule,
    OrganizzeModule,
    PluggyModule,
    SettingsModule,
    ReconciliationModule,
    BalancesModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: BasicAuthGuard,
    },
  ],
})
export class AppModule {}
