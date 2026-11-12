import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor, Public, Roles } from '../../common/auth';
import { Idempotent } from '../../common/idempotency.interceptor';
import { ReviewsService } from './reviews.service';

class ReviewDto {
  @IsUUID() bookingId!: string;
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
  @IsOptional() @IsObject() breakdown?: Record<string, number>;
}

@ApiTags('reviews')
@Controller('v1')
export class ReviewsController {
  constructor(private readonly svc: ReviewsService) {}

  @Roles('customer', 'provider') @Post('reviews') @Idempotent()
  create(@CurrentActor() a: Actor, @Body() d: ReviewDto) { return this.svc.create(a, d); }

  @Public() @Get('users/:id/reviews')
  list(@Param('id', ParseUUIDPipe) id: string) { return this.svc.forUser(id); }
}
