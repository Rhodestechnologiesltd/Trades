import { Module } from '@nestjs/common';
import { RequestsModule } from '../requests/requests.module';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';

@Module({ imports: [RequestsModule], controllers: [RecurringController], providers: [RecurringService], exports: [RecurringService] })
export class RecurringModule {}
