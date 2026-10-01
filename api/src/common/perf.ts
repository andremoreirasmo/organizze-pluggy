import { Logger } from '@nestjs/common';

const logger = new Logger('Perf');

export function startPerf(label: string): {
  mark: (step: string) => void;
  end: (extra?: string) => number;
} {
  const started = Date.now();
  let last = started;
  logger.log(`[perf] start ${label}`);

  return {
    mark(step: string) {
      const now = Date.now();
      logger.log(
        `[perf] ${label} · ${step} +${now - last}ms (total ${now - started}ms)`,
      );
      last = now;
    },
    end(extra?: string) {
      const total = Date.now() - started;
      logger.log(
        `[perf] end ${label} · ${total}ms${extra ? ` · ${extra}` : ''}`,
      );
      return total;
    },
  };
}
