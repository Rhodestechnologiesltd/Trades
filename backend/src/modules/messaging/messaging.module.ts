import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({ controllers: [MessagingController, ConversationsController], providers: [MessagingService, ConversationsService] })
export class MessagingModule {}
