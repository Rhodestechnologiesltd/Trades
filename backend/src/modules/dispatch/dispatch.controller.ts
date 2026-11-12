import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { ValidationError } from '../../common/errors';
import { DispatchService } from './dispatch.service';

class DeclineDto { @IsOptional() @IsString() @MaxLength(300) reason?: string; }

const num = (v: any, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`${name} is required`);
  return n;
};

@ApiTags('dispatch')
@Controller('v1')
export class DispatchController {
  constructor(private readonly svc: DispatchService) {}

  @Roles('admin', 'support') @Get('dispatch/nearby-providers')
  nearby(@Query('lat') lat: string, @Query('lng') lng: string, @Query('radiusM') r?: string, @Query('categoryId') cat?: string) {
    return this.svc.adminNearby(num(lat, 'lat'), num(lng, 'lng'), Number(r ?? 10000), cat);
  }

  @Roles('admin', 'support') @Post('dispatch/:requestId/dispatch') @HttpCode(200)
  redispatch(@Param('requestId', ParseUUIDPipe) id: string) { return this.svc.runMatching(id); }

  @Roles('admin', 'support') @Get('dispatch/:requestId/log')
  log(@Param('requestId', ParseUUIDPipe) id: string) { return this.svc.dispatchLog(id); }

  @Roles('provider') @Post('dispatch/:requestId/decline') @HttpCode(200)
  decline(@CurrentActor() a: Actor, @Param('requestId', ParseUUIDPipe) id: string, @Body() dto: DeclineDto) { return this.svc.decline(a, id, dto.reason); }

  @Roles('customer') @Get('geo/providers')
  providers(@Query('lat') lat: string, @Query('lng') lng: string, @Query('radiusM') r?: string, @Query('categoryId') cat?: string) {
    return this.svc.providersNear(num(lat, 'lat'), num(lng, 'lng'), Number(r ?? 10000), cat);
  }

  @Roles('provider') @Get('geo/jobs')
  jobs(@CurrentActor() a: Actor, @Query('radiusM') r?: string, @Query('limit') limit?: number) {
    return this.svc.jobsForProvider(a, { radiusM: r ? Number(r) : undefined, limit });
  }
}
