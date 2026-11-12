import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Actor, CurrentActor } from '../../common/auth';
import { MessagingService } from './messaging.service';

class SendDto { @IsString() @Length(1, 2000) body!: string; @IsOptional() @IsUUID() toProviderId?: string; }

@ApiTags('messages')
@Controller('v1/service-requests/:id/messages')
export class MessagingController {
  constructor(private readonly svc: MessagingService) {}
  @Get() thread(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('with') withUser?: string) { return this.svc.thread(a, id, withUser); }
  @Post() send(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendDto) { return this.svc.send(a, id, dto.body, dto.toProviderId); }
}
