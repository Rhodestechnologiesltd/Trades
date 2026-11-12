import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { DisputeReason, DisputeResolution } from '@trades/domain';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { Idempotent } from '../../common/idempotency.interceptor';
import { DisputesService } from './disputes.service';

class OpenDto {
  @IsUUID() bookingId!: string;
  @IsIn(['no_show', 'incomplete_work', 'damage', 'overcharge', 'unsafe_conduct', 'other']) reasonCode!: DisputeReason;
  @IsString() @Length(10, 4000) description!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) evidenceKeys?: string[];
}
class MessageDto {
  @IsString() @Length(1, 4000) body!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) attachmentKeys?: string[];
  @IsOptional() @IsBoolean() internalOnly?: boolean;
}
class EvidenceDto { @IsString() @Length(5, 2000) message!: string; @IsOptional() @IsInt() @Min(4) @Max(168) dueInHours?: number; }
class ResolveDto {
  @IsIn(['refund_full', 'refund_partial', 'release_to_provider', 'split']) resolution!: DisputeResolution;
  @IsOptional() @IsNumberString() adjustedAmount?: string;
  @IsString() @Length(10, 4000) notes!: string;
}

@ApiTags('disputes')
@Controller('v1/disputes')
export class DisputesController {
  constructor(private readonly svc: DisputesService) {}

  @Roles('customer', 'provider') @Post() @Idempotent()
  open(@CurrentActor() a: Actor, @Body() d: OpenDto) { return this.svc.open(a, d); }

  @Roles('customer', 'provider') @Get('mine') mine(@CurrentActor() a: Actor) { return this.svc.mine(a); }

  @Roles('admin', 'support', 'finance') @Get()
  queue(@Query('status') status?: string, @Query('routedTo') routedTo?: string) { return this.svc.queue({ status, routedTo }); }

  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(a, id); }

  @Post(':id/messages') message(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: MessageDto) { return this.svc.message(a, id, d); }

  @Roles('customer', 'provider') @Post(':id/withdraw') @HttpCode(200)
  withdraw(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.withdraw(a, id); }

  @Roles('admin', 'support', 'finance') @Post(':id/start-review') @HttpCode(200)
  review(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.startReview(a, id); }

  @Roles('admin', 'support', 'finance') @Post(':id/request-evidence') @HttpCode(200)
  evidence(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: EvidenceDto) { return this.svc.requestEvidence(a, id, d); }

  @Roles('admin', 'support', 'finance') @Post(':id/resolve') @HttpCode(200) @Idempotent()
  resolve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: ResolveDto) { return this.svc.resolve(a, id, d); }
}
