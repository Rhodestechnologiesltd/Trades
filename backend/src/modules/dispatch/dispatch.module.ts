import { Global, Module } from '@nestjs/common';
import { DispatchController } from './dispatch.controller';
import { DispatchService } from './dispatch.service';

@Global()
@Module({ controllers: [DispatchController], providers: [DispatchService], exports: [DispatchService] })
export class DispatchModule {}
