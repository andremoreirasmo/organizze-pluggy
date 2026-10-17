import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ReconciliationService } from '../reconciliation/reconciliation.service';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const reconciliation = app.get(ReconciliationService);
    const result = await reconciliation.backfillHistorySnapshots({ force });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ force, ...result }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
