import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { RecurringService } from './recurring.service';

class CreateDto {
  @IsUUID() categoryId!: string;
  @IsUUID() addressId!: string;
  @IsString() @Length(8, 200) cadenceRule!: string;
  @IsDateString() startsOn!: string;
  @IsOptional() @IsInt() @Min(30) @Max(720) durationMin?: number;
  @IsString() @Length(5, 2000) description!: string;
  @IsOptional() @IsUUID() preferredProviderId?: string;
  @IsOptional() @IsNumberString() agreedRate?: string;
  @IsOptional() @IsInt() @Min(12) @Max(168) leadTimeHours?: number;
}
class StatusDto { @IsIn(['pause', 'resume', 'cancel']) action!: 'pause' | 'resume' | 'cancel'; }

@ApiTags('recurring')
@Controller('v1/recurring-agreements')
export class RecurringController {
  constructor(private readonly svc: RecurringService) {}
  @Roles('customer') @Post() create(@CurrentActor() a: Actor, @Body() d: CreateDto) { return this.svc.create(a, d); }
  @Roles('customer', 'provider') @Get() list(@CurrentActor() a: Actor) { return this.svc.list(a); }
  @Roles('customer', 'provider', 'admin') @Post(':id/status') @HttpCode(200)
  status(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: StatusDto) { return this.svc.setStatus(a, id, d.action); }
}
