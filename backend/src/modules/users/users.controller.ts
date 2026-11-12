import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsLatitude, IsLongitude, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Actor, CurrentActor, Roles } from '../../common/auth';
import { UsersService } from './users.service';

class UpdateMeDto {
  @IsOptional() @IsString() @Length(2, 120) fullName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() avatarKey?: string;
}

export class AddressDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string;
  @IsString() @Length(2, 200) line1!: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @IsString() @Length(2, 100) city!: string;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string;
  @IsOptional() @IsString() @Length(2, 2) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(300) accessNotes?: string;
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
  @IsOptional() @IsIn(['exact', 'approximate']) precisionLevel?: 'exact' | 'approximate';
  @IsOptional() @IsBoolean() makeDefault?: boolean;
}

@ApiTags('users')
@Controller('v1')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me') me(@CurrentActor() a: Actor) { return this.users.me(a); }
  @Patch('me') update(@CurrentActor() a: Actor, @Body() dto: UpdateMeDto) { return this.users.updateMe(a, dto); }
  @Post('me/delete') @HttpCode(200) del(@CurrentActor() a: Actor) { return this.users.deleteAccount(a); }

  @Roles('customer') @Get('customers/me/addresses') list(@CurrentActor() a: Actor) { return this.users.listAddresses(a); }
  @Roles('customer') @Post('customers/me/addresses') create(@CurrentActor() a: Actor, @Body() dto: AddressDto) { return this.users.createAddress(a, dto); }
  @Roles('customer') @Patch('customers/me/addresses/:id') patch(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: Partial<AddressDto>) { return this.users.updateAddress(a, id, dto); }
  @Roles('customer') @Delete('customers/me/addresses/:id') remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.users.deleteAddress(a, id); }
}
