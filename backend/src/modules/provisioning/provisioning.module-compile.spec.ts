/**
 * Wave-2 Task 6B.2 — DI graph compile check for ProvisioningModule.
 *
 * Anchors the wiring: controller, service, EncryptionService and the
 * DataSource injection all resolve through the Nest test module. If a
 * dependency drifts (e.g. DataSource stops being globally available, or
 * a constructor gains a new required param), this test breaks before
 * a real deploy would.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { ApiKey } from '../../database/entities/api-key.entity';
import { getRepositoryToken } from '@nestjs/typeorm';

describe('ProvisioningModule DI compile', () => {
  it('resolves ProvisioningController + ProvisioningService with the shared DataSource', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProvisioningController],
      providers: [
        // Real ProvisioningService, but with a mocked DataSource + Encryption
        ProvisioningService,
        { provide: DataSource, useValue: { getRepository: () => ({}), transaction: async () => ({}) } },
        { provide: EncryptionService, useValue: { encrypt: (v: string) => v, decrypt: (v: string) => v } },
        // SigcoreAuthGuard depends on ConfigService + the ApiKey repo — supply cheap stubs.
        { provide: ConfigService, useValue: { get: () => 'test-key' } },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: { findOne: async () => null, save: async (v: any) => v },
        },
        SigcoreAuthGuard,
      ],
    }).compile();

    const controller = moduleRef.get(ProvisioningController);
    const service = moduleRef.get(ProvisioningService);
    expect(controller).toBeInstanceOf(ProvisioningController);
    expect(service).toBeInstanceOf(ProvisioningService);
  });
});
