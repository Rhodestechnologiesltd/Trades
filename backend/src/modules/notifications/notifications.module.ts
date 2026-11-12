import { Module } from '@nestjs/common';
import { EmailChannel, PushChannel, SmsChannel } from './channels';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [PushChannel, SmsChannel, EmailChannel, NotificationsService, NotificationsListener],
  exports: [NotificationsService, SmsChannel, PushChannel, EmailChannel],
})
export class NotificationsModule {}
