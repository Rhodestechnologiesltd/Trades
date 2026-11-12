import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

const E164 = /^\+[1-9]\d{6,14}$/;

export class RegisterCustomerDto {
  @Matches(E164, { message: 'phone must be E.164, e.g. +23057123456' }) phone!: string;
  @IsString() @Length(2, 120) fullName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
}

export class RegisterProviderDto extends RegisterCustomerDto {
  @IsOptional() @IsString() @MaxLength(160) businessName?: string;
}

export class RequestOtpDto {
  @Matches(E164) phone!: string;
  @IsOptional() @IsIn(['login', 'register', 'step_up']) purpose?: 'login' | 'register' | 'step_up';
}

export class VerifyOtpDto {
  @Matches(E164) phone!: string;
  @Matches(/^\d{6}$/) code!: string;
  @IsString() @Length(8, 128) deviceId!: string;
  @IsOptional() @IsString() @MaxLength(120) deviceName?: string;
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: 'ios' | 'android' | 'web';
  @IsOptional() @IsIn(['customer', 'provider']) app?: 'customer' | 'provider';
  @IsOptional() isRooted?: boolean;
}

export class RefreshDto {
  @IsString() @Length(20, 200) refreshToken!: string;
}

export class StaffLoginDto {
  @IsEmail() email!: string;
  @IsString() @Length(10, 200) password!: string;
  @Matches(/^\d{6}$/) totp!: string;
  @IsString() @Length(8, 128) deviceId!: string;
}

export class StepUpDto {
  @Matches(/^\d{6}$/) code!: string;
}
