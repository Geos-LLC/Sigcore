import { ChannelType } from '../../database/entities/sender.entity';
import { tpnSupportsChannel } from './tpn-channel';

describe('tpnSupportsChannel', () => {
  describe('post-Wave-2 rows (metadata.activeChannels present)', () => {
    it("channel='both' purchase — supports voice AND sms", () => {
      // Regression: the exact TPN shape a `both` purchase produces.
      // Before the fix, dial-guard checked the enum column (SMS) and
      // 400ed on voice, forcing a manual UPDATE tenant_phone_numbers
      // SET channel='voice' workaround.
      const tpn = {
        channel: ChannelType.SMS,
        metadata: {
          capabilities: ['sms', 'voice', 'mms'],
          requestedChannel: 'both',
          activeChannels: ['sms', 'voice'],
        },
      };
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(true);
    });

    it("channel='voice' purchase — supports voice, not sms", () => {
      const tpn = {
        channel: ChannelType.VOICE,
        metadata: { requestedChannel: 'voice', activeChannels: ['voice'] },
      };
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(false);
    });

    it("channel='sms' purchase — supports sms, not voice", () => {
      const tpn = {
        channel: ChannelType.SMS,
        metadata: { requestedChannel: 'sms', activeChannels: ['sms'] },
      };
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(false);
    });

    it('metadata.activeChannels is the source of truth over the column', () => {
      // If someone hand-edits the column (as happened during incident
      // triage) but metadata still says sms-only, honour the metadata
      // — the operator hasn't re-issued the number, so it truly is
      // sms-only regardless of what the enum slot happens to say.
      const tpn = {
        channel: ChannelType.VOICE,
        metadata: { requestedChannel: 'sms', activeChannels: ['sms'] },
      };
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(false);
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(true);
    });
  });

  describe('pre-Wave-2 rows (metadata missing or malformed) — grandfathered', () => {
    it('no metadata field: fall back to column', () => {
      const smsOnly = { channel: ChannelType.SMS, metadata: null };
      expect(tpnSupportsChannel(smsOnly, 'sms')).toBe(true);
      expect(tpnSupportsChannel(smsOnly, 'voice')).toBe(false);

      const voiceOnly = { channel: ChannelType.VOICE };
      expect(tpnSupportsChannel(voiceOnly, 'voice')).toBe(true);
      expect(tpnSupportsChannel(voiceOnly, 'sms')).toBe(false);
    });

    it('metadata present but activeChannels absent: fall back to column', () => {
      const tpn = {
        channel: ChannelType.VOICE,
        metadata: { capabilities: ['sms', 'voice'] },
      };
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(false);
    });

    it('metadata.activeChannels malformed (not array): fall back to column', () => {
      const tpn = {
        channel: ChannelType.SMS,
        metadata: { activeChannels: 'sms' as unknown as string[] },
      };
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(false);
    });

    it('metadata is an array (bad shape): fall back to column', () => {
      const tpn = {
        channel: ChannelType.VOICE,
        metadata: ['garbage'] as unknown as Record<string, unknown>,
      };
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(false);
    });
  });

  describe('defensive filtering — unknown channels in activeChannels', () => {
    it("ignores non-'sms'/'voice' entries in activeChannels", () => {
      const tpn = {
        channel: ChannelType.SMS,
        metadata: {
          activeChannels: ['sms', 'voice', 'fax', 'whatsapp', 42, null],
        },
      };
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(true);
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(true);
    });

    it('empty activeChannels array is honoured (supports nothing)', () => {
      const tpn = {
        channel: ChannelType.SMS,
        metadata: { activeChannels: [] },
      };
      expect(tpnSupportsChannel(tpn, 'sms')).toBe(false);
      expect(tpnSupportsChannel(tpn, 'voice')).toBe(false);
    });
  });
});
