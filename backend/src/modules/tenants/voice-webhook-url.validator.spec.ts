import { BadRequestException } from '@nestjs/common';
import { validateVoiceInboundUrl } from './voice-webhook-url.validator';

// PR 2 URL validation. The runbook lists these exact rejection cases:
// ftp, ws, wss, file, javascript, malformed, empty; plus http rejected in
// prod (allowInsecureLocalhost=false), permitted for localhost in dev/test.

describe('validateVoiceInboundUrl', () => {
  const strict = { allowInsecureLocalhost: false };
  const lax = { allowInsecureLocalhost: true };

  describe('accepts', () => {
    it('https:// URL to any host', () => {
      expect(
        validateVoiceInboundUrl('https://example.com/twilio/inbound', strict),
      ).toBe('https://example.com/twilio/inbound');
    });

    it('https:// URL with port and path', () => {
      expect(
        validateVoiceInboundUrl(
          'https://callio-production-47ac.up.railway.app:443/webhooks/twilio/voice/6e378229',
          strict,
        ),
      ).toContain('/webhooks/twilio/voice/6e378229');
    });

    it('normalizes trailing whitespace', () => {
      expect(
        validateVoiceInboundUrl('  https://example.com/x  ', strict),
      ).toBe('https://example.com/x');
    });

    it('http://localhost accepted only when allowInsecureLocalhost=true', () => {
      expect(validateVoiceInboundUrl('http://localhost:3000/x', lax)).toBe(
        'http://localhost:3000/x',
      );
      expect(validateVoiceInboundUrl('http://127.0.0.1:3000/x', lax)).toBe(
        'http://127.0.0.1:3000/x',
      );
    });
  });

  describe('rejects', () => {
    it('non-string input', () => {
      expect(() =>
        validateVoiceInboundUrl(42 as unknown, strict),
      ).toThrow(BadRequestException);
      expect(() =>
        validateVoiceInboundUrl({} as unknown, strict),
      ).toThrow(BadRequestException);
    });

    it('empty string', () => {
      expect(() => validateVoiceInboundUrl('', strict)).toThrow(
        BadRequestException,
      );
    });

    it('whitespace-only string', () => {
      expect(() => validateVoiceInboundUrl('   ', strict)).toThrow(
        BadRequestException,
      );
    });

    it('malformed URL', () => {
      expect(() => validateVoiceInboundUrl('not a url', strict)).toThrow(
        BadRequestException,
      );
      expect(() =>
        validateVoiceInboundUrl('http:///malformed', strict),
      ).toThrow(BadRequestException);
    });

    it.each([
      ['ftp://example.com/file', 'ftp'],
      ['ws://example.com/', 'ws'],
      ['wss://example.com/', 'wss'],
      ['file:///etc/passwd', 'file'],
      ['javascript:alert(1)', 'javascript'],
      ['data:text/plain;base64,YQ==', 'data'],
      ['gopher://example.com/', 'gopher'],
    ])('scheme %s → 400 (%s)', (url) => {
      expect(() => validateVoiceInboundUrl(url, strict)).toThrow(
        BadRequestException,
      );
      expect(() => validateVoiceInboundUrl(url, lax)).toThrow(
        BadRequestException,
      );
    });

    it('http:// to non-localhost host in ANY mode → 400', () => {
      expect(() =>
        validateVoiceInboundUrl('http://example.com/x', strict),
      ).toThrow(BadRequestException);
      expect(() =>
        validateVoiceInboundUrl('http://example.com/x', lax),
      ).toThrow(BadRequestException);
    });

    it('http://localhost rejected in production (strict mode)', () => {
      expect(() =>
        validateVoiceInboundUrl('http://localhost:3000/x', strict),
      ).toThrow(BadRequestException);
    });
  });
});
