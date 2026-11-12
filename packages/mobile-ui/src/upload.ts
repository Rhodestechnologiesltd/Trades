import type { Api } from '@trades/shared';
import { ApiError } from '@trades/shared';

/** Uploads a local file URI (camera / image picker) through a presigned S3 PUT; returns the storage key. */
export async function uploadUri(api: Api, purpose: 'kyc' | 'license' | 'job_photo' | 'request_photo' | 'dispute_evidence' | 'avatar', uri: string, mime?: string): Promise<string> {
  const local = await fetch(uri);
  const blob = await local.blob();
  const contentType = mime ?? (blob.type || (uri.toLowerCase().endsWith('.png') ? 'image/png' : uri.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'));
  const target = await api.media.uploadUrl(purpose, contentType, blob.size);
  const res = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body: blob });
  if (!res.ok) throw new ApiError(res.status, 'upload_failed', 'Upload failed. Please try again.');
  return target.key;
}
