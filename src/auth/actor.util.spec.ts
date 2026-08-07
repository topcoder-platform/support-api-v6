import { UnauthorizedException } from '@nestjs/common';
import {
  buildSupportActor,
  getAuthRoles,
  normalizeRoleClaim,
  normalizeScopeClaim,
} from './actor.util';

describe('actor utilities', () => {
  it('preserves a multi-word support role supplied as one claim', () => {
    expect(normalizeRoleClaim('Topcoder Support Team')).toEqual([
      'Topcoder Support Team',
    ]);
  });

  it('reads namespaced roles without treating unrelated claims as roles', () => {
    expect(
      getAuthRoles({
        'https://topcoder.com/roles': ['Topcoder Support Team', 'Member'],
        profile: 'ignored',
      }),
    ).toEqual(['Topcoder Support Team', 'Member']);
  });

  it('normalizes array and space-delimited OAuth scopes', () => {
    expect(
      normalizeScopeClaim(['read:roles write:bus_api', 'read:members']),
    ).toEqual(['read:roles', 'write:bus_api', 'read:members']);
  });

  it('recognizes the exact support role case-insensitively', () => {
    const actor = buildSupportActor({
      roles: ['  topcoder support team  '],
      userId: 123456,
      handle: 'support_agent',
    });

    expect(actor).toMatchObject({
      handle: 'support_agent',
      isMachine: false,
      isSupportTeam: true,
      userId: '123456',
    });
  });

  it('does not grant support access for a partial role name', () => {
    expect(
      buildSupportActor({
        roles: ['Support Team'],
        userId: '123456',
      }).isSupportTeam,
    ).toBe(false);
  });

  it('rejects human tokens without a scalar user ID', () => {
    expect(() => buildSupportActor({ userId: { nested: true } })).toThrow(
      UnauthorizedException,
    );
    expect(() => buildSupportActor({ userId: Number.NaN })).toThrow(
      UnauthorizedException,
    );
  });
});
