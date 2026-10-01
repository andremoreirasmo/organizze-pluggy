import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { join } from 'path';
import { existsSync } from 'fs';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production' ? undefined : false,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.setGlobalPrefix('api', {
    exclude: ['/'],
  });

  const isProd = config.get('NODE_ENV') === 'production';
  const webDist = join(__dirname, '..', '..', 'web', 'dist');

  if (isProd && existsSync(webDist)) {
    app.useStaticAssets(webDist);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      return res.sendFile(join(webDist, 'index.html'));
    });
  } else if (!isProd) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && req.path === '/') {
        res
          .status(200)
          .type('html')
          .send(
            `<!doctype html><meta http-equiv="refresh" content="0;url=http://localhost:5173"><p>Dev UI: <a href="http://localhost:5173">http://localhost:5173</a> (Vite HMR)</p>`,
          );
        return;
      }
      next();
    });
  }

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}`);
  if (!isProd) {
    console.log(`Frontend (HMR): http://localhost:5173`);
  }
}

bootstrap();
