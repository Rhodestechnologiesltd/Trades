import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsLatitude, IsLongitude, IsNumberString, IsOptional, IsString,
  IsUUID, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { Idempotent } from '../../common/idempotency.interceptor';
import { RequestsService } from './requests.service';

class LocationDto {
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
  @IsIn(['gps', 'manual']) source!: 'gps' | 'manual';
  @IsOptional() @IsString() @MaxLength(300) addressText?: string;
  @IsOptional() @IsString() @MaxLength(80) areaLabel?: string;
}

export class CreateRequestDto {
  @IsUUID() categoryId!: string;
  @IsIn(['scheduled', 'urgent', 'recurring']) mode!: 'scheduled' | 'urgent' | 'recurring';
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsString() @Length(5, 4000) description!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) photoKeys?: string[];
  @IsOptional() @IsDateString() scheduledFor?: string;
  @IsOptional() @IsInt() @Min(30) @Max(720) scheduledWindowMin?: number;
  @IsOptional() @IsIn(['normal', 'high', 'critical']) urgencyLevel?: 'normal' | 'high' | 'critical';
  @IsOptional() @IsNumberString() budgetHint?: string;
  @IsOptional() @IsUUID() addressId?: string;
  @IsOptional() @ValidateNested() @Type(() => LocationDto) location?: LocationDto;
  @IsOptional() @IsIn(['exact', 'approximate']) precisionLevel?: 'exact' | 'approximate';
  @IsOptional() @IsBoolean() instantAccept?: boolean;
}

class CancelDto { @IsOptional() @IsString() @MaxLength(500) reason?: string; }

@ApiTags('service-requests')
@Controller('v1/service-requests')
export class RequestsController {
  constructor(private readonly svc: RequestsService) {}

  @Roles('customer') @Post() @Idempotent()
  create(@CurrentActor() a: Actor, @Body() dto: CreateRequestDto) { return this.svc.create(a, dto); }

  @Roles('customer') @Get()
  list(@CurrentActor() a: Actor, @Query('cursor') cursor?: string, @Query('limit') limit?: number, @Query('status') status?: string) {
    return this.svc.listMine(a, { cursor, limit, status });
  }

  @Get(':id')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(a, id); }

  @Roles('customer', 'admin', 'support') @Post(':id/cancel') @HttpCode(200)
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) { return this.svc.cancel(a, id, dto.reason); }
}
