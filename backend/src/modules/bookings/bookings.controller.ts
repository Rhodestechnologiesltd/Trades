import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { Idempotent } from '../../common/idempotency.interceptor';
import { BookingsService } from './bookings.service';

class StartDto { @IsOptional() @IsLatitude() lat?: number; @IsOptional() @IsLongitude() lng?: number; @IsOptional() @IsNumber() accuracyM?: number; }
class CompleteDto {
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) photoKeys?: string[];
  @IsOptional() @IsLatitude() lat?: number; @IsOptional() @IsLongitude() lng?: number;
}
class CancelDto { @IsString() @Length(3, 500) reason!: string; }
class JobEventDto {
  @IsIn(['en_route', 'arrived', 'photo_uploaded', 'note_added']) type!: 'en_route' | 'arrived' | 'photo_uploaded' | 'note_added';
  @IsOptional() @IsLatitude() lat?: number; @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) photoKeys?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(600) etaMin?: number;
}

@ApiTags('bookings')
@Controller('v1/bookings')
export class BookingsController {
  constructor(private readonly svc: BookingsService) {}

  @Roles('customer', 'provider') @Get('history')
  history(@CurrentActor() a: Actor, @Query('cursor') cursor?: string, @Query('limit') limit?: number, @Query('status') status?: string) {
    return this.svc.history(a, { cursor, limit, status });
  }

  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(a, id); }
  @Get(':id/tracking') tracking(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.tracking(a, id); }

  @Roles('provider') @Post(':id/start') @HttpCode(200) @Idempotent()
  start(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: StartDto) { return this.svc.start(a, id, d); }

  @Roles('provider') @Post(':id/complete') @HttpCode(200) @Idempotent()
  complete(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: CompleteDto) { return this.svc.complete(a, id, d); }

  @Roles('provider') @Post(':id/job-events') @HttpCode(200)
  jobEvent(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: JobEventDto) { return this.svc.jobEvent(a, id, d); }

  @Roles('customer') @Post(':id/approve') @HttpCode(200) @Idempotent()
  approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.approve(a, id); }

  @Roles('customer', 'provider', 'admin', 'support') @Post(':id/cancel') @HttpCode(200) @Idempotent()
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: CancelDto) { return this.svc.cancel(a, id, d.reason); }

  @Roles('customer', 'admin', 'support') @Post(':id/no-show') @HttpCode(200) @Idempotent()
  noShow(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: CancelDto) { return this.svc.cancel(a, id, d.reason, { noShow: true }); }
}
