import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { Idempotent } from '../../common/idempotency.interceptor';
import { QuotesService } from './quotes.service';

class SubmitQuoteDto {
  @IsUUID() requestId!: string;
  @IsNumberString() amount!: string;
  @IsOptional() @IsString() @MaxLength(1000) message?: string;
  @IsOptional() @IsDateString() estimatedStartAt?: string;
  @IsOptional() @IsInt() @Min(15) @Max(7 * 24 * 60) estimatedDurationMin?: number;
  @IsOptional() @IsInt() @Min(10) @Max(72 * 60) validForMin?: number;
}
class CounterDto { @IsNumberString() amount!: string; @IsOptional() @IsString() @MaxLength(500) message?: string; }
class RespondDto {
  @IsIn(['accept', 'reject', 'counter']) action!: 'accept' | 'reject' | 'counter';
  @IsOptional() @IsNumberString() amount?: string;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
}

@ApiTags('quotes')
@Controller('v1')
export class QuotesController {
  constructor(private readonly svc: QuotesService) {}

  @Roles('provider') @Post('quotes') @Idempotent()
  submit(@CurrentActor() a: Actor, @Body() d: SubmitQuoteDto) { return this.svc.submit(a, d); }

  @Roles('provider') @Get('quotes/mine')
  mine(@CurrentActor() a: Actor, @Query('status') status?: string) { return this.svc.mine(a, status); }

  @Roles('provider') @Post('quotes/:id/withdraw') @HttpCode(200)
  withdraw(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.withdraw(a, id); }

  @Roles('customer') @Post('quotes/:id/counter-offers') @Idempotent()
  counter(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: CounterDto) { return this.svc.counter(a, id, d); }

  @Roles('customer', 'provider') @Post('counter-offers/:id/respond') @HttpCode(200) @Idempotent()
  respond(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: RespondDto) { return this.svc.respond(a, id, d); }

  @Roles('customer') @Post('quotes/:id/accept') @HttpCode(200) @Idempotent()
  accept(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.accept(a, id); }

  @Roles('provider') @Post('service-requests/:id/instant-accept') @HttpCode(200) @Idempotent()
  instant(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.instantAccept(a, id); }
}
