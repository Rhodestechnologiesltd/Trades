import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, IsUUID, Length } from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PayoutsService } from './payouts.service';

class ReasonDto { @IsString() @Length(3, 1000) reason!: string; }
class ConfirmDto { @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) payoutIds!: string[]; @IsString() @Length(2, 100) bankReference!: string; }

@ApiTags('payouts')
@Controller('v1/payouts')
export class PayoutsController {
  constructor(private readonly svc: PayoutsService) {}

  /** Manual override of the scheduled T+48h release (§E) — finance/admin only, audit-logged. */
  @Roles('finance', 'admin') @Post(':bookingId/release') @HttpCode(200) @Idempotent()
  release(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string, @Body() d: ReasonDto) { return this.svc.manualRelease(a, id, d.reason); }

  @Roles('finance', 'admin') @Post(':bookingId/hold') @HttpCode(200)
  hold(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string, @Body() d: ReasonDto) { return this.svc.hold(a, id, d.reason); }

  @Roles('finance', 'admin') @Post(':bookingId/unhold') @HttpCode(200)
  unhold(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string, @Body() d: ReasonDto) { return this.svc.unhold(a, id, d.reason); }

  @Roles('finance', 'admin') @Get()
  list(@Query('status') status?: string, @Query('providerId') providerId?: string) { return this.svc.list({ status, providerId }); }

  @Roles('finance') @Post('batches/export') @HttpCode(200)
  async export(@CurrentActor() a: Actor, @Query('marketId', ParseUUIDPipe) marketId: string, @Res() res: any) {
    const { batch, csv } = await this.svc.exportBatch(a, marketId);
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', `attachment; filename="payout-batch-${batch?.id ?? 'empty'}.csv"`);
    res.send(csv);
  }

  @Roles('finance') @Post('batches/confirm') @HttpCode(200) @Idempotent()
  confirm(@CurrentActor() a: Actor, @Body() d: ConfirmDto) { return this.svc.confirmManual(a, d.payoutIds, d.bankReference); }

  @Roles('finance', 'admin') @Post('clawbacks/:id/write-off') @HttpCode(200)
  writeOff(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto) { return this.svc.writeOffClawback(a, id, d.reason); }
}
