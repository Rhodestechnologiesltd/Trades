import { Module } from '@nestjs/common';
import { RequestsModule } from '../requests/requests.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({ imports: [RequestsModule], controllers: [BookingsController], providers: [BookingsService], exports: [BookingsService] })
export class BookingsModule {}
