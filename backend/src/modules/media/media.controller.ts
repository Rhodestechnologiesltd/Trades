import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { Actor, CurrentActor } from '../../common/auth';
import { MediaService, UploadPurpose } from './media.service';

class UploadDto {
  @IsIn(['kyc', 'license', 'job_photo', 'request_photo', 'dispute_evidence', 'avatar']) purpose!: UploadPurpose;
  @IsString() contentType!: string;
  @IsInt() @Min(1) @Max(50_000_000) sizeBytes!: number;
}

@ApiTags('media')
@Controller('v1/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-url')
  upload(@CurrentActor() a: Actor, @Body() dto: UploadDto) { return this.media.createUpload(a, dto.purpose, dto.contentType, dto.sizeBytes); }
}
