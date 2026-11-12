import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { AppModule } from './app.module';
import { assertProductionConfig, config } from './common/config';

async function bootstrap() {
  assertProductionConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: false });
  app.use(helmet());
  app.use((req: any, res: any, next: () => void) => {
    req.id = req.headers['x-request-id'] ?? randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });
  app.enableCors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.enableShutdownHooks();
  // Behind a load balancer: trust X-Forwarded-For for rate limiting / audit IPs.
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);

  if (!config.isProd) {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle('Trades Marketplace API').setVersion('1.0').addBearerAuth()
      .setDescription('Customer, provider and ops API. Money-moving POSTs require an Idempotency-Key header.').build());
    SwaggerModule.setup('docs', app, doc);
  }
  await app.listen(config.port);
  new Logger('Bootstrap').log(`API listening on :${config.port} (${config.env}, gateway=${config.payment.gateway})`);
}
bootstrap();
