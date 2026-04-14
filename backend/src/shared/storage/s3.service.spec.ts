import { S3Service } from './s3.service';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

describe('S3Service', () => {
  const s3Mock = mockClient(S3Client);
  let service: S3Service;

  beforeEach(() => {
    s3Mock.reset();
    process.env.AWS_S3_BUCKET_WHATSAPP_MEDIA = 'test-bucket';
    process.env.AWS_REGION = 'us-east-1';
    service = new S3Service();
  });

  afterAll(() => {
    delete process.env.AWS_S3_BUCKET_WHATSAPP_MEDIA;
    delete process.env.AWS_REGION;
  });

  describe('buildKey', () => {
    it('returns deterministic whatsapp/{workspaceId}/{messageId}.{ext} format', () => {
      expect(service.buildKey('ws-1', 'msg-abc', '.jpg')).toBe('whatsapp/ws-1/msg-abc.jpg');
    });

    it('adds dot prefix to ext if missing', () => {
      expect(service.buildKey('ws-1', 'msg-abc', 'png')).toBe('whatsapp/ws-1/msg-abc.png');
    });
  });

  describe('isConfigured', () => {
    it('returns true when bucket env is set', () => {
      expect(service.isConfigured()).toBe(true);
    });

    it('returns false when bucket env is missing', () => {
      delete process.env.AWS_S3_BUCKET_WHATSAPP_MEDIA;
      const unconfigured = new S3Service();
      expect(unconfigured.isConfigured()).toBe(false);
      process.env.AWS_S3_BUCKET_WHATSAPP_MEDIA = 'test-bucket';
    });
  });

  describe('headObject', () => {
    it('returns true when object exists', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      expect(await service.headObject('whatsapp/ws-1/msg.jpg')).toBe(true);
    });

    it('returns false on 404', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ $metadata: { httpStatusCode: 404 }, name: 'NotFound' });
      expect(await service.headObject('whatsapp/ws-1/missing.jpg')).toBe(false);
    });
  });

  describe('putObject (idempotency)', () => {
    it('skips upload when object already exists', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      // PutObject should never be called — but configure a response just in case
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await service.putObject({
        key: 'whatsapp/ws-1/msg.jpg',
        body: Buffer.from('fake'),
        contentType: 'image/jpeg',
      });

      expect(result).toEqual({ uploaded: false, skipped: true });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('uploads when object does not exist', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ $metadata: { httpStatusCode: 404 }, name: 'NotFound' });
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await service.putObject({
        key: 'whatsapp/ws-1/new.jpg',
        body: Buffer.from('fake'),
        contentType: 'image/jpeg',
      });

      expect(result).toEqual({ uploaded: true, skipped: false });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      const call = s3Mock.commandCalls(PutObjectCommand)[0];
      expect(call.args[0].input.Bucket).toBe('test-bucket');
      expect(call.args[0].input.Key).toBe('whatsapp/ws-1/new.jpg');
      expect(call.args[0].input.ContentType).toBe('image/jpeg');
    });
  });

  describe('getObjectStream', () => {
    it('returns stream + contentType on success', async () => {
      const body = Readable.from([Buffer.from('image-bytes')]);
      s3Mock.on(GetObjectCommand).resolves({ Body: body as any, ContentType: 'image/jpeg' });

      const result = await service.getObjectStream('whatsapp/ws-1/msg.jpg');
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('image/jpeg');
    });

    it('returns null on 404', async () => {
      s3Mock.on(GetObjectCommand).rejects({ $metadata: { httpStatusCode: 404 }, name: 'NoSuchKey' });
      const result = await service.getObjectStream('whatsapp/ws-1/missing.jpg');
      expect(result).toBeNull();
    });
  });
});
