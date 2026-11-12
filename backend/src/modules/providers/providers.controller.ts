import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsNumberString, IsOptional,
  IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Actor, CurrentActor, Public, Roles } from '../../common/auth';
import { ProvidersService } from './providers.service';

class ProfileDto {
  @IsOptional() @IsString() @MaxLength(160) businessName?: string;
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @IsOptional() @IsInt() @Min(0) @Max(80) yearsExperience?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) languages?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(20) maxConcurrentJobs?: number;
  @IsOptional() @IsBoolean() instantAcceptEnabled?: boolean;
}
class CategoryItem {
  @IsUUID() categoryId!: string;
  @IsOptional() @IsNumberString() priceBandMin?: string;
  @IsOptional() @IsNumberString() priceBandMax?: string;
}
class CategoriesDto { @IsArray() @ValidateNested({ each: true }) @Type(() => CategoryItem) categories!: CategoryItem[]; }
class Point { @IsLatitude() lat!: number; @IsLongitude() lng!: number; }
class ZoneDto {
  @IsIn(['radius', 'polygon']) type!: 'radius' | 'polygon';
  @IsOptional() @IsLatitude() centerLat?: number;
  @IsOptional() @IsLongitude() centerLng?: number;
  @IsOptional() @IsInt() @Min(500) @Max(100000) radiusM?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(200) coordinates?: [number, number][];
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
class LocationsDto {
  @ValidateNested() @Type(() => Point) homeBase!: Point;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ZoneDto) zones!: ZoneDto[];
}
class AvailabilityDto { @IsIn(['online', 'offline', 'busy']) status!: 'online' | 'offline' | 'busy'; }
class PingDto {
  @IsLatitude() lat!: number; @IsLongitude() lng!: number;
  @IsOptional() @IsNumber() accuracyM?: number;
  @IsOptional() @IsBoolean() isMocked?: boolean;
  @IsOptional() @IsDateString() recordedAt?: string;
  @IsOptional() @IsUUID() bookingId?: string;
}
class DocumentDto {
  @IsIn(['id_front', 'id_back', 'selfie', 'license', 'certificate', 'background_check', 'proof_of_address']) kind!: string;
  @IsString() storageKey!: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}
class PayoutAccountDto {
  @IsIn(['bank_transfer', 'mobile_wallet']) method!: 'bank_transfer' | 'mobile_wallet';
  @IsString() @Length(2, 120) accountHolderName!: string;
  @IsOptional() @IsString() bankName?: string;
  @IsString() @Length(6, 40) accountNumber!: string;
  @IsOptional() @IsString() bankCode?: string;
  @Matches(/^\d{6}$/) stepUpCode!: string;
}
class WindowDto { @IsInt() @Min(0) @Max(6) weekday!: number; @Matches(/^\d{2}:\d{2}$/) start!: string; @Matches(/^\d{2}:\d{2}$/) end!: string; }
class WindowsDto { @IsArray() @ValidateNested({ each: true }) @Type(() => WindowDto) windows!: WindowDto[]; }
class TimeOffDto { @IsDateString() startsAt!: string; @IsDateString() endsAt!: string; }

@ApiTags('providers')
@Controller('v1/providers')
export class ProvidersController {
  constructor(private readonly svc: ProvidersService) {}

  @Roles('provider') @Get('me') me(@CurrentActor() a: Actor) { return this.svc.getMine(a); }
  @Roles('provider') @Patch('me/profile') profile(@CurrentActor() a: Actor, @Body() d: ProfileDto) { return this.svc.updateProfile(a, d); }
  @Roles('provider') @Put('me/categories') categories(@CurrentActor() a: Actor, @Body() d: CategoriesDto) { return this.svc.setCategories(a, d.categories); }
  @Roles('provider') @Put('me/locations') locations(@CurrentActor() a: Actor, @Body() d: LocationsDto) { return this.svc.setLocations(a, d); }
  @Roles('provider') @Patch('me/availability') availability(@CurrentActor() a: Actor, @Body() d: AvailabilityDto) { return this.svc.setAvailability(a, d.status); }
  @Roles('provider') @Post('me/location-ping') @HttpCode(200) ping(@CurrentActor() a: Actor, @Body() d: PingDto) { return this.svc.locationPing(a, d); }
  @Roles('provider') @Post('me/documents') document(@CurrentActor() a: Actor, @Body() d: DocumentDto) { return this.svc.addDocument(a, d); }
  @Roles('provider') @Post('me/submit-verification') @HttpCode(200) submit(@CurrentActor() a: Actor) { return this.svc.submitForVerification(a); }
  @Roles('provider') @Put('me/payout-account') payout(@CurrentActor() a: Actor, @Body() d: PayoutAccountDto) { return this.svc.setPayoutAccount(a, d); }
  @Roles('provider') @Get('me/earnings') earnings(@CurrentActor() a: Actor) { return this.svc.earnings(a); }
  @Roles('provider') @Put('me/availability-windows') windows(@CurrentActor() a: Actor, @Body() d: WindowsDto) { return this.svc.setAvailabilityWindows(a, d.windows); }
  @Roles('provider') @Post('me/time-off') timeOff(@CurrentActor() a: Actor, @Body() d: TimeOffDto) { return this.svc.addTimeOff(a, d.startsAt, d.endsAt); }

  @Public() @Get(':id') publicProfile(@Param('id', ParseUUIDPipe) id: string) { return this.svc.publicProfile(id); }
}
