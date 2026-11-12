import { Global, Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { PAYMENT_GATEWAYS } from './gateway';
import { MipsGateway } from './mips.gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SandboxGateway } from './sandbox.gateway';

@Global()
@Module({
  imports: [PayoutsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService, SandboxGateway, MipsGateway,
    {
      provide: PAYMENT_GATEWAYS,
      useFactory: (sandbox: SandboxGateway, mips: MipsGateway) => ({ sandbox, mips }),
      inject: [SandboxGateway, MipsGateway],
    },
  ],
  exports: [PaymentsService, PayoutsModule],
})
export class PaymentsModule {}
