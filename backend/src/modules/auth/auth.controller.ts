import { Body, Controller, Delete, Get, HttpCode, Ip, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor, CurrentActor, Public } from '../../common/auth';
import { AuthService } from './auth.service';
import { RefreshDto, RegisterCustomerDto, RegisterProviderDto, RequestOtpDto, StaffLoginDto, VerifyOtpDto } from './auth.dto';

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('customers/register')
  registerCustomer(@Body() dto: RegisterCustomerDto, @Ip() ip: string) { return this.auth.registerCustomer(dto, ip); }

  @Public() @Post('providers/register')
  registerProvider(@Body() dto: RegisterProviderDto, @Ip() ip: string) { return this.auth.registerProvider(dto, ip); }

  @Public() @Post('otp/request') @HttpCode(200)
  requestOtp(@Body() dto: RequestOtpDto, @Ip() ip: string) { return this.auth.requestOtp(dto.phone, dto.purpose === 'step_up' ? 'login' : dto.purpose ?? 'login', ip); }

  @Public() @Post('otp/verify') @HttpCode(200)
  verify(@Body() dto: VerifyOtpDto, @Ip() ip: string, @Req() req: any) { return this.auth.verifyOtp(dto, ip, req.headers['user-agent']); }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Ip() ip: string, @Req() req: any) { return this.auth.refresh(dto.refreshToken, ip, req.headers['user-agent']); }

  @Public() @Post('staff/login') @HttpCode(200)
  staffLogin(@Body() dto: StaffLoginDto, @Ip() ip: string, @Req() req: any) {
    return this.auth.staffLogin(dto.email, dto.password, dto.totp, dto.deviceId, ip, req.headers['user-agent']);
  }

  @Post('logout') @HttpCode(200)
  logout(@CurrentActor() a: Actor) { return this.auth.logout(a); }

  @Get('sessions')
  sessions(@CurrentActor() a: Actor) { return this.auth.listSessions(a); }

  @Delete('sessions/:id')
  revoke(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.auth.revokeSession(a, id); }

  @Post('step-up/start') @HttpCode(200)
  stepUp(@CurrentActor() a: Actor) { return this.auth.startStepUp(a); }
}
