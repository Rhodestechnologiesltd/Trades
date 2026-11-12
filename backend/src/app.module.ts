import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthGuard, Public } from './common/auth';
import { CommonModule } from './common/common.module';
import { DbService } from './common/db.service';
import { GlobalExceptionFilter } from './common/errors';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { MediaModule } from './modules/media/media.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RecurringModule } from './modules/recurring/recurring.module';
import { RequestsModule } from './modules/requests/requests.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { UsersModule } from './modules/users/users.module';

@Controller()
class HealthController {
  constructor(private readonly db: DbService) {}
  @Public() @Get('healthz') live() { return { ok: true }; }
  @Public() @Get('readyz') async ready() { await this.db.pool.query('SELECT 1'); return { ok: true, db: 'up' }; }
}

/**
 * Modular monolith: each module maps 1:1 to a service in spec §B (Auth, Booking/Request,
 * Geolocation & Dispatch, Payment/Ledger, Notification, Reviews/Dispute, Scheduler, Admin).
 * Modules talk through services + the transactional outbox, so any of them can be
 * extracted into its own deployable (e.g. Dispatch in Go, §M) without changing callers.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 50 }),
    CommonModule, RealtimeModule, MediaModule, LedgerModule,
    AuthModule, UsersModule, CatalogModule, ProvidersModule, NotificationsModule,
    RequestsModule, DispatchModule, PaymentsModule, BookingsModule, QuotesModule,
    DisputesModule, ReviewsModule, RecurringModule, MessagingModule, AdminModule, SchedulerModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
