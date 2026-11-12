import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth';
import { PlatformConfigService } from '../../common/platform-config.service';
import { DbService } from '../../common/db.service';
import { PLATFORM_DEFAULT_FEES, FeeConfig, resolveFeeConfig } from '@trades/domain';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService, private readonly cfg: PlatformConfigService, private readonly db: DbService) {}

  @Public() @Get('categories')
  tree() { return this.catalog.tree(); }

  @Public() @Get('categories/:id/price-bands')
  bands(@Param('id', ParseUUIDPipe) id: string, @Query('marketId', ParseUUIDPipe) marketId: string) { return this.catalog.priceBands(id, marketId); }

  @Public() @Get('markets')
  markets() { return this.catalog.markets(); }

  /** Fee display info for apps (server remains authoritative at booking time; categories may override). */
  @Public() @Get('config/public')
  async publicConfig(@Query('marketId') marketId?: string) {
    const platform = await this.cfg.get<FeeConfig>('fees', PLATFORM_DEFAULT_FEES);
    const m = marketId ? await this.db.one(`SELECT currency_code, customer_fee_bps, provider_commission_bps FROM markets WHERE id = $1`, [marketId]).catch(() => null) : null;
    const fees = resolveFeeConfig(platform, { market: m ? { customerFeeBps: m.customer_fee_bps ?? undefined, providerCommissionBps: m.provider_commission_bps ?? undefined } : null });
    const timing = await this.cfg.timing();
    return {
      currency: m?.currency_code ?? 'MUR',
      customerFeePct: fees.customerFeeBps / 100,
      providerCommissionPct: fees.providerCommissionBps / 100,
      payoutDelayHours: timing.payoutDelaySec / 3600,
      disputeWindowHours: timing.disputeWindowSec / 3600,
      autoApproveHours: timing.autoApproveAfterSec / 3600,
    };
  }
}
