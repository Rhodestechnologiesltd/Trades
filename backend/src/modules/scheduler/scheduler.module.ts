import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { DisputesModule } from '../disputes/disputes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuotesModule } from '../quotes/quotes.module';
import { RecurringModule } from '../recurring/recurring.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { SchedulerService } from './scheduler.service';

@Module({ imports: [BookingsModule, DisputesModule, NotificationsModule, QuotesModule, RecurringModule, ReviewsModule], providers: [SchedulerService], exports: [SchedulerService] })
export class SchedulerModule {}
