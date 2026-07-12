import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

import { TenantVoiceForwarderService } from './tenant-voice-forwarder.service';
import { EmailService } from '../email/email.service';

// PR 3 module-compile test.
//
// Verifies TenantVoiceForwarderService is resolvable through the Nest DI
// graph with only external overrides (ConfigService + EmailService come
// from the standard ConfigModule + EmailModule wiring in production).

describe('PR 3 tenant voice forwarder DI graph (real bootstrap)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY || '0'.repeat(64);
  });

  it('resolves TenantVoiceForwarderService with ConfigService + EmailService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [ConfigService, EmailService, TenantVoiceForwarderService],
    }).compile();

    const svc = moduleRef.get(TenantVoiceForwarderService);
    expect(svc).toBeDefined();
    expect(typeof (svc as any).forward).toBe('function');

    await moduleRef.close();
  });
});

// Runtime search — exactly one forwarding call site per Georgi's PR 3 spec.
//
// Walks backend/src excluding *.spec.ts and asserts that `.forward(` on the
// forwarder service is called from at most ONE runtime file: the twilio
// inbound webhooks service. A future refactor that adds a second call site
// will fail this test loudly.
describe('PR 3 invariant: exactly one runtime forwarding call site', () => {
  const SRC_ROOT = path.resolve(__dirname, '..', '..');
  const IGNORE_DIRS = new Set(['node_modules', 'dist', 'migrations']);

  function walk(dir: string, out: string[]): void {
    for (const name of fs.readdirSync(dir)) {
      if (IGNORE_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, out);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  }

  it('only twilio-webhooks.service.ts calls voiceForwarder.forward(...)', () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);

    // Grep for a call to `.forward(` on the voice forwarder handle.
    // Property names are stable — the injected property is `voiceForwarder`
    // (see TwilioWebhooksService constructor).
    const callers = files.filter((f) => {
      const content = fs.readFileSync(f, 'utf8');
      return /voiceForwarder[.!?]?\.forward\(/.test(content);
    });

    const callerNames = callers.map((f) => path.basename(f)).sort();
    expect(callerNames).toEqual(['twilio-webhooks.service.ts']);
  });
});
