import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertProductionConfig } from './common/config';

/**
 * Background worker: runs the scheduler sweeps, outbox relay and notification
 * delivery without serving HTTP. Scale horizontally — jobs are guarded by advisory
 * locks and every sweep is idempotent.
 */
async function bootstrap() {
  process.env.WORKER = 'true';
  assertProductionConfig();
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker started');
}
bootstrap();
