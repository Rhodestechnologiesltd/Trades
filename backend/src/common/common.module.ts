import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DbService } from './db.service';
import { OutboxService } from './outbox.service';
import { PlatformConfigService } from './platform-config.service';
import { RateLimitService } from './rate-limit.service';
import { StateService } from './state.service';

@Global()
@Module({
  providers: [DbService, AuditService, StateService, OutboxService, PlatformConfigService, RateLimitService],
  exports: [DbService, AuditService, StateService, OutboxService, PlatformConfigService, RateLimitService],
})
export class CommonModule {}
