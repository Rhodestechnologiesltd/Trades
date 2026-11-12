import { Module } from '@nestjs/common';
import { config } from '../../common/config';
import { DISBURSEMENT_RAIL } from '../payments/gateway';
import { ManualBankFileRail, SandboxDisbursementRail } from '../payments/sandbox.gateway';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({
  controllers: [PayoutsController],
  providers: [
    PayoutsService, SandboxDisbursementRail, ManualBankFileRail,
    {
      provide: DISBURSEMENT_RAIL,
      useFactory: (sbx: SandboxDisbursementRail, manual: ManualBankFileRail) => (config.disbursementRail === 'sandbox' && !config.isProd ? sbx : manual),
      inject: [SandboxDisbursementRail, ManualBankFileRail],
    },
  ],
  exports: [PayoutsService],
})
export class PayoutsModule {}
