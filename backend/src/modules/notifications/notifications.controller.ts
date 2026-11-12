import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Actor, CurrentActor } from '../../common/auth';
import { NotificationsService } from './notifications.service';

class PushTokenDto {
  @IsString() @Length(10, 300) token!: string;
  @IsIn(['ios', 'android', 'web']) platform!: string;
}
class PrefDto {
  @IsString() eventType!: string;
  @IsArray() @IsIn(['push', 'sms', 'email', 'in_app'], { each: true }) channels!: string[];
}
class PrefsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => PrefDto) preferences!: PrefDto[];
}

@ApiTags('notifications')
@Controller('v1')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get('notifications')
  feed(@CurrentActor() a: Actor, @Query('cursor') cursor?: string, @Query('limit') limit?: number) { return this.svc.feed(a.userId!, cursor, limit); }

  @Post('notifications/:id/read') @HttpCode(200)
  read(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.markRead(a.userId!, id); }

  @Post('notifications/read-all') @HttpCode(200)
  readAll(@CurrentActor() a: Actor) { return this.svc.markRead(a.userId!); }

  @Post('me/push-tokens') @HttpCode(200)
  pushToken(@CurrentActor() a: Actor, @Body() dto: PushTokenDto) { return this.svc.registerPushToken(a.userId!, dto.token, dto.platform); }

  @Put('me/notification-preferences')
  prefs(@CurrentActor() a: Actor, @Body() dto: PrefsDto) { return this.svc.setPreferences(a.userId!, dto.preferences); }
}
