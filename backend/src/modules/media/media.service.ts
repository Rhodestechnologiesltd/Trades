import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { Actor } from '../../common/auth';
import { config } from '../../common/config';
import { ForbiddenError, ValidationError } from '../../common/errors';

export type UploadPurpose = 'kyc' | 'license' | 'job_photo' | 'request_photo' | 'dispute_evidence' | 'avatar';

const ALLOWED: Record<UploadPurpose, { types: string[]; maxBytes: number; roles: string[] }> = {
  kyc:              { types: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10e6, roles: ['provider'] },
  license:          { types: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10e6, roles: ['provider'] },
  job_photo:        { types: ['image/jpeg', 'image/png', 'image/heic'], maxBytes: 12e6, roles: ['provider', 'customer'] },
  request_photo:    { types: ['image/jpeg', 'image/png', 'image/heic'], maxBytes: 12e6, roles: ['customer'] },
  dispute_evidence: { types: ['image/jpeg', 'image/png', 'image/heic', 'application/pdf', 'video/mp4'], maxBytes: 50e6, roles: ['customer', 'provider', 'admin', 'support', 'finance'] },
  avatar:           { types: ['image/jpeg', 'image/png'], maxBytes: 5e6, roles: ['customer', 'provider'] },
};

/**
 * Object storage via short-lived signed URLs only (§B.2 Media/Document Storage).
 * Keys are namespaced by owner so authorisation can be checked from the key.
 * Bucket must have SSE encryption + lifecycle rules (KYC retention) configured.
 */
@Injectable()
export class MediaService {
  private readonly s3 = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: !!config.s3.endpoint,
    credentials: config.s3.accessKeyId ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } : undefined,
  });

  async createUpload(actor: Actor, purpose: UploadPurpose, contentType: string, sizeBytes: number) {
    const rule = ALLOWED[purpose];
    if (!rule) throw new ValidationError('Unknown upload purpose');
    if (!rule.roles.includes(actor.type)) throw new ForbiddenError('You cannot upload this kind of file');
    if (!rule.types.includes(contentType)) throw new ValidationError(`Unsupported file type ${contentType}`);
    if (!(sizeBytes > 0 && sizeBytes <= rule.maxBytes)) throw new ValidationError(`File too large (max ${Math.round(rule.maxBytes / 1e6)}MB)`);
    const ext = contentType.split('/')[1].replace('jpeg', 'jpg');
    const key = `${purpose}/${actor.userId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    const url = await getSignedUrl(this.s3, new PutObjectCommand({
      Bucket: config.s3.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes,
      ServerSideEncryption: 'AES256',
    }), { expiresIn: 600 });
    return { key, uploadUrl: url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresInSec: 600 };
  }

  /** Signed GET; callers must have authorised access to the owning record first. */
  async signedGet(key: string, expiresIn = 300): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), { expiresIn });
  }

  ownerOf(key: string): string | null {
    return key.split('/')[1] ?? null;
  }

  assertOwnedBy(key: string, userId: string) {
    if (this.ownerOf(key) !== userId) throw new ForbiddenError('File does not belong to you');
  }
}
