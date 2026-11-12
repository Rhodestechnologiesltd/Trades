import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Allow, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsLatitude, IsLongitude, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
} from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { ValidationError } from '../../common/errors';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PlatformConfigService } from '../../common/platform-config.service';
import { BookingsService } from '../bookings/bookings.service';
import { CatalogService } from '../catalog/catalog.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentsService } from '../payments/payments.service';
import { ReviewsService } from '../reviews/reviews.service';
import { AdminService } from './admin.service';

class VerifyDto { @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject'; @IsOptional() @IsString() reason?: string; }
class DocReviewDto { @IsIn(['approved', 'rejected']) status!: 'approved' | 'rejected'; @IsOptional() @IsString() notes?: string; }
class UserStatusDto { @IsIn(['active', 'suspended', 'banned']) status!: 'active' | 'suspended' | 'banned'; @IsString() @Length(3, 500) reason!: string; }
class StaffDto { @IsEmail() email!: string; @IsString() @Length(2, 120) fullName!: string; @IsIn(['admin', 'support', 'finance']) role!: 'admin' | 'support' | 'finance'; @IsString() @Length(12, 200) password!: string; }
class CategoryDto {
  @IsOptional() @IsUUID() parent_id?: string; @IsOptional() @Matches(/^[a-z0-9-]{2,60}$/) slug?: string; @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string; @IsOptional() @IsString() icon?: string; @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() requires_license?: boolean; @IsOptional() @IsBoolean() requires_background_check?: boolean; @IsOptional() @IsBoolean() urgency_allowed?: boolean;
  @IsOptional() @IsInt() average_job_duration_min?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) customer_fee_bps?: number | null; @IsOptional() @IsInt() @Min(0) @Max(5000) provider_commission_bps?: number | null;
  @IsOptional() @IsNumberString() price_floor?: string | null; @IsOptional() @IsNumberString() price_ceiling?: string | null; @IsOptional() @IsNumberString() instant_accept_price?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(10) max_negotiation_rounds?: number | null; @IsOptional() @IsBoolean() is_active?: boolean;
  @IsString() @Length(3, 500) reason!: string;
}
class MarketDto {
  @IsOptional() @IsInt() @Min(0) @Max(5000) customerFeeBps?: number | null; @IsOptional() @IsInt() @Min(0) @Max(5000) providerCommissionBps?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean; @IsOptional() @IsInt() maxDispatchRadiusM?: number; @IsString() @Length(3, 500) reason!: string;
}
class NewMarketDto {
  @Matches(/^[A-Z]{2}$/) countryCode!: string; @IsString() city!: string; @Matches(/^[A-Z]{3}$/) currencyCode!: string; @IsString() timezone!: string;
  @IsLatitude() centerLat!: number; @IsLongitude() centerLng!: number; @IsString() @Length(3, 500) reason!: string;
}
class ConfigDto { @Allow() value!: unknown; @IsString() @Length(3, 500) reason!: string; }
class GoodwillDto { @IsNumberString() amount!: string; @IsString() @Length(10, 1000) reason!: string; }
class SettlementReportDto {
  @IsString() gateway!: string; @IsDateString() reportDate!: string; @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsNumberString() grossAmount!: string; @IsOptional() @IsNumberString() feesAmount?: string; @IsNumberString() netAmount!: string;
  @IsArray() lines!: Array<{ reference: string; amount: string; type?: string }>;
}
class ReconcileDto { @IsDateString() date!: string; @Matches(/^[A-Z]{3}$/) currency!: string; @IsOptional() @IsString() gateway?: string; }
class ChargebackDto {
  @IsOptional() @IsUUID() paymentId?: string; @IsOptional() @IsString() gatewayReference?: string; @IsOptional() @IsNumberString() amount?: string;
  @IsString() reference!: string; @IsOptional() @IsDateString() respondBy?: string; @IsOptional() @IsString() reason?: string;
}
class FraudDto { @IsIn(['reviewing', 'actioned', 'dismissed']) status!: 'reviewing' | 'actioned' | 'dismissed'; @IsOptional() @IsString() note?: string; }
class MarkPaidDto { @IsString() @Length(2, 100) bankReference!: string; }
class HideDto { @IsBoolean() hidden!: boolean; @IsString() @Length(3, 500) reason!: string; }

const CONFIG_KEYS = ['fees', 'timing', 'negotiation', 'cancellation', 'abuse', 'dispatch', 'ranking', 'support_goodwill_cap', 'payout_account_cooloff_sec'];

/** Internal ops API. RBAC per spec §I; every mutation is audit-logged with a reason. */
@ApiTags('admin')
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly svc: AdminService,
    private readonly catalog: CatalogService,
    private readonly cfg: PlatformConfigService,
    private readonly ledger: LedgerService,
    private readonly bookings: BookingsService,
    private readonly dispatch: DispatchService,
    private readonly payments: PaymentsService,
    private readonly reviews: ReviewsService,
  ) {}

  @Roles('admin', 'support', 'finance') @Get('dashboard') dashboard(@Query('marketId') marketId?: string) { return this.svc.dashboard(marketId); }
  @Roles('admin', 'finance') @Get('analytics/:kind') analytics(@Param('kind') kind: any, @Query('days') days?: string) {
    if (!['funnel', 'category-demand', 'provider-utilization', 'heatmap'].includes(kind)) throw new ValidationError('Unknown report');
    return this.svc.analytics(kind, Number(days ?? 30));
  }

  // providers & KYC
  @Roles('admin', 'support') @Get('providers') providers(@Query('status') status?: string) { return this.svc.verificationQueue(status ?? 'pending'); }
  @Roles('admin', 'support') @Get('providers/:id') provider(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.providerDetail(a, id); }
  @Roles('admin', 'support') @Post('providers/:id/verification') @HttpCode(200)
  verify(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: VerifyDto) { return this.svc.decideVerification(a, id, d.decision, d.reason); }
  @Roles('admin', 'support') @Post('documents/:id/review') @HttpCode(200)
  reviewDoc(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: DocReviewDto) { return this.svc.reviewDocument(a, id, d.status, d.notes); }

  // users & staff
  @Roles('admin', 'support') @Get('users') users(@Query('q') q?: string, @Query('type') type?: string) { return this.svc.searchUsers(q, type); }
  @Roles('admin') @Post('users/:id/status') @HttpCode(200)
  userStatus(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: UserStatusDto) { return this.svc.setUserStatus(a, id, d.status, d.reason); }
  @Roles('admin') @Post('staff') createStaff(@CurrentActor() a: Actor, @Body() d: StaffDto) { return this.svc.createStaff(a, d); }

  // taxonomy, markets, configuration (admin only — §I "Configure commission/fee rates")
  @Roles('admin', 'support', 'finance') @Get('categories') categories() { return this.catalog.tree(true); }
  @Roles('admin') @Post('categories') createCategory(@CurrentActor() a: Actor, @Body() d: CategoryDto) { const { reason, ...data } = d; return this.catalog.upsert(a, null, data, reason); }
  @Roles('admin') @Patch('categories/:id') updateCategory(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: CategoryDto) { const { reason, ...data } = d; return this.catalog.upsert(a, id, data, reason); }
  @Roles('admin', 'finance') @Get('markets') markets() { return this.catalog.markets(false); }
  @Roles('admin') @Post('markets') createMarket(@CurrentActor() a: Actor, @Body() d: NewMarketDto) { const { reason, ...data } = d; return this.catalog.createMarket(a, data, reason); }
  @Roles('admin') @Patch('markets/:id') updateMarket(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: MarketDto) { const { reason, ...data } = d; return this.catalog.updateMarket(a, id, data, reason); }
  @Roles('admin', 'finance') @Get('config') config() { return this.cfg.all(); }
  @Roles('admin') @Put('config/:key')
  async setConfig(@CurrentActor() a: Actor, @Param('key') key: string, @Body() d: ConfigDto) {
    if (!CONFIG_KEYS.includes(key)) throw new ValidationError('Unknown config key');
    if (key === 'fees') {
      const v: any = d.value;
      for (const k of ['customerFeeBps', 'providerCommissionBps']) if (!Number.isInteger(v?.[k]) || v[k] < 0 || v[k] > 5000) throw new ValidationError(`${k} must be 0..5000 bps`);
    }
    await this.cfg.set(key, d.value, a, d.reason);
    return { key, value: d.value };
  }

  // operations
  @Roles('admin', 'support', 'finance') @Get('bookings') bookingList(@Query('status') status?: string, @Query('q') q?: string) { return this.svc.bookings({ status, q }); }
  @Roles('admin', 'support', 'finance') @Get('bookings/:id')
  async booking(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    const b = await this.bookings.get(a, id);
    const [journals, dispatchLog] = await Promise.all([this.ledger.journals({ bookingId: id }), this.dispatch.dispatchLog(b.requestId)]);
    return { ...b, journals, dispatchLog };
  }
  @Roles('admin', 'support') @Get('requests') requests(@Query('status') status?: string, @Query('adminAssist') adminAssist?: string) { return this.svc.requests({ status, adminAssist: adminAssist === 'true' }); }
  @Roles('admin', 'support', 'finance') @Post('bookings/:id/goodwill-refund') @HttpCode(200) @Idempotent()
  goodwill(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: GoodwillDto) { return this.svc.goodwillRefund(a, id, d.amount, d.reason); }
  @Roles('admin', 'finance') @Get('refunds') refunds(@Query('status') status?: string) { return this.svc.refunds(status); }
  @Roles('finance') @Post('refunds/:id/mark-paid') @HttpCode(200) @Idempotent()
  markPaid(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: MarkPaidDto) { return this.payments.markRefundPaidManually(a, id, d.bankReference); }
  @Roles('finance') @Post('chargebacks') @Idempotent() chargeback(@CurrentActor() a: Actor, @Body() d: ChargebackDto) { return this.svc.ingestChargeback(a, d); }

  // ledger & reconciliation (finance)
  @Roles('finance', 'admin') @Get('ledger/trial-balance') trial(@Query('currency') c?: string) { return this.ledger.trialBalance(c); }
  @Roles('finance', 'admin') @Get('ledger/journals') journals(@Query('bookingId') bookingId?: string, @Query('kind') kind?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.ledger.journals({ bookingId, kind, from, to });
  }
  @Roles('finance', 'admin') @Get('ledger/providers/:id') providerBalance(@Param('id', ParseUUIDPipe) id: string) { return this.ledger.providerBalance(id); }
  @Roles('finance') @Post('ledger/settlement-reports') importReport(@CurrentActor() a: Actor, @Body() d: SettlementReportDto) { return this.ledger.importSettlementReport(a, d); }
  @Roles('finance') @Post('ledger/reconcile') @HttpCode(200) reconcile(@Body() d: ReconcileDto) { return this.ledger.reconcile(d.date.slice(0, 10), d.currency, d.gateway); }
  @Roles('finance', 'admin') @Get('ledger/reconciliation-runs') runs() { return this.ledger.reconciliationRuns(); }

  // trust & safety
  @Roles('admin', 'support', 'finance') @Get('audit-logs')
  audit(@CurrentActor() a: Actor, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string, @Query('actorId') actorId?: string, @Query('action') action?: string) {
    // §I: support sees a limited view (non-financial), finance sees the financial subset.
    if (a.type === 'support' && ['payout', 'refund', 'platform_config', 'payment'].includes(entityType ?? '')) throw new ValidationError('Not available for your role');
    return this.svc.auditLogs({ entityType, entityId, actorId, action }, a.type === 'finance');
  }
  @Roles('admin', 'support') @Get('fraud-signals') fraud(@Query('status') status?: string) { return this.svc.fraudSignals(status); }
  @Roles('admin', 'support') @Post('fraud-signals/:id') @HttpCode(200)
  fraudUpdate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: FraudDto) { return this.svc.updateFraudSignal(a, id, d.status, d.note); }
  @Roles('admin', 'support') @Get('reviews/flagged') flagged() { return this.reviews.flagged(); }
  @Roles('admin') @Post('reviews/:id/visibility') @HttpCode(200)
  hide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: HideDto) { return this.reviews.hide(a, id, d.reason, d.hidden); }
  @Roles('admin', 'support') @Get('notifications/failed') failed() { return this.svc.failedNotifications(); }
  @Roles('admin', 'support') @Post('notifications/:id/retry') @HttpCode(200) retry(@Param('id', ParseUUIDPipe) id: string) { return this.svc.retryNotification(id); }
}
