import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({ imports: [BookingsModule], controllers: [QuotesController], providers: [QuotesService], exports: [QuotesService] })
export class QuotesModule {}
