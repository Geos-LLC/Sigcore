import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export interface PutObjectParams {
  key: string;
  body: Buffer;
  contentType?: string;
}

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private _client: S3Client | null = null;

  private get bucket(): string {
    return process.env.AWS_S3_BUCKET_WHATSAPP_MEDIA || '';
  }

  private get client(): S3Client {
    if (this._client) return this._client;
    const region = process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    this._client = new S3Client({
      region,
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
    return this._client;
  }

  isConfigured(): boolean {
    return !!this.bucket;
  }

  buildKey(workspaceId: string, messageId: string, ext: string): string {
    const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
    return `whatsapp/${workspaceId}/${messageId}${safeExt}`;
  }

  async headObject(key: string): Promise<boolean> {
    if (!this.bucket) return false;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') {
        return false;
      }
      throw e;
    }
  }

  /**
   * Idempotent upload. HEAD first; if object already exists, skip.
   * Prevents re-upload on reconnect / re-sync / retries.
   */
  async putObject(params: PutObjectParams): Promise<{ uploaded: boolean; skipped: boolean }> {
    if (!this.bucket) throw new Error('AWS_S3_BUCKET_WHATSAPP_MEDIA not configured');

    const exists = await this.headObject(params.key);
    if (exists) {
      this.logger.debug(`[S3] Skipping upload (already exists): ${params.key}`);
      return { uploaded: false, skipped: true };
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
    return { uploaded: true, skipped: false };
  }

  async getObjectStream(key: string): Promise<{ stream: Readable; contentType?: string } | null> {
    if (!this.bucket) return null;
    try {
      const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = resp.Body as Readable | undefined;
      if (!body) return null;
      return { stream: body, contentType: resp.ContentType };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null;
      throw e;
    }
  }
}
