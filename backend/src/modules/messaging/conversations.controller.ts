import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { ConversationsService } from './conversations.service';

@Roles('customer', 'provider')
@Controller('v1/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}
  @Get()
  list(@CurrentActor() actor: Actor) { return this.conversations.list(actor); }
  @Get(':userId')
  messages(@CurrentActor() actor: Actor, @Param('userId', ParseUUIDPipe) userId: string, @Query('cursor') cursor?: string) {
    return this.conversations.messages(actor, userId, cursor);
  }
}
