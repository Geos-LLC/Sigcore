/**
 * 2026-08-17 — pure-function coverage for the effective-caller resolver.
 * Every branch of the V1 resolution rule has an assertion here so a
 * future edit that regresses (e.g. accidentally trusts a malformed
 * ForwardedFrom, or lets the business forwarding number leak through
 * as the customer's identity) fails fast.
 */
import { resolveEffectiveCaller } from './resolve-effective-caller.util';

const FROM_CUSTOMER = '+19547163388'; // Broward County, FL
const FROM_QUO = '+18139212100';      // Spotless's Quo business DID
const TO_CALLIO = '+19045778584';     // Callio-owned Twilio DID
const BIZ_FORWARDING = '+18139212100';// tenant.metadata.callForwardingNumber

describe('resolveEffectiveCaller — direct calls (no ForwardedFrom)', () => {
  it('direct call: effective = From, source = from_direct', () => {
    const r = resolveEffectiveCaller({
      from: FROM_CUSTOMER,
      to: TO_CALLIO,
    });
    expect(r.effectiveCallerNumber).toBe(FROM_CUSTOMER);
    expect(r.resolutionSource).toBe('from_direct');
    expect(r.reason).toBeNull();
    expect(r.rawFrom).toBe(FROM_CUSTOMER);
    expect(r.rawForwardedFrom).toBeNull();
  });

  it('undefined ForwardedFrom → from_direct', () => {
    const r = resolveEffectiveCaller({
      from: FROM_CUSTOMER,
      to: TO_CALLIO,
      forwardedFrom: undefined,
    });
    expect(r.resolutionSource).toBe('from_direct');
  });

  it('empty-string ForwardedFrom → from_direct', () => {
    const r = resolveEffectiveCaller({
      from: FROM_CUSTOMER,
      to: TO_CALLIO,
      forwardedFrom: '',
    });
    expect(r.resolutionSource).toBe('from_direct');
    expect(r.rawForwardedFrom).toBeNull();
  });

  it('whitespace-only ForwardedFrom → from_direct', () => {
    const r = resolveEffectiveCaller({
      from: FROM_CUSTOMER,
      to: TO_CALLIO,
      forwardedFrom: '   ',
    });
    expect(r.resolutionSource).toBe('from_direct');
    expect(r.rawForwardedFrom).toBeNull();
  });
});

describe('resolveEffectiveCaller — genuine SIP-native forward (customer surfaces)', () => {
  it('Quo-style: From=business, ForwardedFrom=customer → effective = customer', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: FROM_CUSTOMER,
      businessForwardingNumber: BIZ_FORWARDING,
    });
    expect(r.effectiveCallerNumber).toBe(FROM_CUSTOMER);
    expect(r.resolutionSource).toBe('forwarded_from');
    expect(r.reason).toBeNull();
    expect(r.rawFrom).toBe(FROM_QUO);
    expect(r.rawForwardedFrom).toBe(FROM_CUSTOMER);
  });

  it('trims whitespace on ForwardedFrom before using it', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: `  ${FROM_CUSTOMER}  `,
    });
    expect(r.effectiveCallerNumber).toBe(FROM_CUSTOMER);
    expect(r.resolutionSource).toBe('forwarded_from');
    // Raw preserves the trimmed value (whitespace never persisted).
    expect(r.rawForwardedFrom).toBe(FROM_CUSTOMER);
  });
});

describe('resolveEffectiveCaller — reject ForwardedFrom (fallback to From)', () => {
  it('malformed E.164 (no leading +) → from_fallback_invalid_forwarded_from / not_e164', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: '9547163388',
    });
    expect(r.effectiveCallerNumber).toBe(FROM_QUO);
    expect(r.resolutionSource).toBe('from_fallback_invalid_forwarded_from');
    expect(r.reason).toBe('not_e164');
    expect(r.rawForwardedFrom).toBe('9547163388'); // preserved for diagnostics
  });

  it('E.164 leading zero digit → not_e164', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: '+09547163388',
    });
    expect(r.effectiveCallerNumber).toBe(FROM_QUO);
    expect(r.reason).toBe('not_e164');
  });

  it('junk string → not_e164', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: 'anonymous',
    });
    expect(r.effectiveCallerNumber).toBe(FROM_QUO);
    expect(r.reason).toBe('not_e164');
  });

  it('ForwardedFrom equals From → equals_from (self-referential; not useful)', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: FROM_QUO,
    });
    expect(r.effectiveCallerNumber).toBe(FROM_QUO);
    expect(r.resolutionSource).toBe('from_fallback_invalid_forwarded_from');
    expect(r.reason).toBe('equals_from');
  });

  it('ForwardedFrom equals To → equals_to (the destination cannot be the forwarder)', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: TO_CALLIO,
    });
    expect(r.effectiveCallerNumber).toBe(FROM_QUO);
    expect(r.resolutionSource).toBe('from_fallback_invalid_forwarded_from');
    expect(r.reason).toBe('equals_to');
  });

  it('ForwardedFrom equals businessForwardingNumber → equals_business_forwarding_number', () => {
    const r = resolveEffectiveCaller({
      from: '+15551230000',
      to: TO_CALLIO,
      forwardedFrom: BIZ_FORWARDING,
      businessForwardingNumber: BIZ_FORWARDING,
    });
    expect(r.effectiveCallerNumber).toBe('+15551230000');
    expect(r.resolutionSource).toBe('from_fallback_invalid_forwarded_from');
    expect(r.reason).toBe('equals_business_forwarding_number');
  });

  it('null / empty businessForwardingNumber does NOT trigger the equals rule', () => {
    const r = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: FROM_CUSTOMER,
      businessForwardingNumber: null,
    });
    expect(r.resolutionSource).toBe('forwarded_from');
    expect(r.effectiveCallerNumber).toBe(FROM_CUSTOMER);
  });
});

describe('resolveEffectiveCaller — session isolation guarantee', () => {
  it('two customers forwarded through the same Quo DID yield distinct effective numbers', () => {
    // Both calls arrive with From = Quo DID (bridge-forwarded through
    // the same PBX). If ForwardedFrom carries the customer identity,
    // the two calls must produce DIFFERENT effectiveCallerNumbers so
    // Callio can create separate sessions.
    const CUSTOMER_A = '+19547163388';
    const CUSTOMER_B = '+18138432729';
    const a = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: CUSTOMER_A,
      businessForwardingNumber: BIZ_FORWARDING,
    });
    const b = resolveEffectiveCaller({
      from: FROM_QUO,
      to: TO_CALLIO,
      forwardedFrom: CUSTOMER_B,
      businessForwardingNumber: BIZ_FORWARDING,
    });
    expect(a.effectiveCallerNumber).not.toBe(b.effectiveCallerNumber);
    expect(a.effectiveCallerNumber).toBe(CUSTOMER_A);
    expect(b.effectiveCallerNumber).toBe(CUSTOMER_B);
  });

  it('two customers forwarded WITHOUT ForwardedFrom yield the SAME effective number (degraded case, no invention)', () => {
    // This is the honest degraded case: bridge-forward that dropped the
    // customer identity. Both calls look like they came from the PBX.
    // We must NOT invent a distinguishing identity — Callio's session
    // isolation instead relies on unique CallSid + timestamp.
    const a = resolveEffectiveCaller({ from: FROM_QUO, to: TO_CALLIO });
    const b = resolveEffectiveCaller({ from: FROM_QUO, to: TO_CALLIO });
    expect(a.effectiveCallerNumber).toBe(b.effectiveCallerNumber);
    expect(a.effectiveCallerNumber).toBe(FROM_QUO);
  });
});
