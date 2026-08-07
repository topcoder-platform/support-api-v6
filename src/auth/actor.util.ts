import { UnauthorizedException } from '@nestjs/common';
import { SupportActor } from './auth.types';

export const SUPPORT_TEAM_ROLE = 'Topcoder Support Team';

/**
 * Converts a scalar JWT claim to a trimmed string without object coercion.
 *
 * @param value decoded JWT claim value.
 * @returns the normalized scalar value, or an empty string for objects.
 * @throws Does not throw.
 */
function scalarClaim(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '';
}

/**
 * Normalizes role-like claims without splitting multi-word role names.
 *
 * @param value JWT claim value containing an array, JSON array, or comma list.
 * @returns trimmed, non-empty claim values.
 * @throws Does not throw; malformed JSON falls back to the literal value.
 */
export function normalizeRoleClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeRoleClaim(entry));
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      return normalizeRoleClaim(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  return trimmed
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

/**
 * Normalizes OAuth scopes from array, space-delimited, or comma-delimited claims.
 *
 * @param value JWT scope claim.
 * @returns normalized scope values.
 * @throws Does not throw.
 */
export function normalizeScopeClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeScopeClaim(entry));
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * Extracts all conventional and namespaced role claims from a decoded JWT user.
 *
 * @param authUser object attached by tc-core-library-js.
 * @returns deduplicated role names.
 * @throws Does not throw.
 */
export function getAuthRoles(authUser: Record<string, unknown>): string[] {
  const roles = Object.entries(authUser)
    .filter(([key]) => /(^|[/.:])roles?$/.test(key.toLowerCase()))
    .flatMap(([, value]) => normalizeRoleClaim(value));
  return Array.from(new Set(roles));
}

/**
 * Builds the strict actor representation used for authorization decisions.
 *
 * @param authUser decoded and validated JWT user.
 * @returns normalized Support actor.
 * @throws UnauthorizedException when a human token has no user identifier.
 */
export function buildSupportActor(
  authUser: Record<string, unknown>,
): SupportActor {
  const isMachine = Boolean(authUser['isMachine']);
  const rawUserId = authUser['userId'] ?? authUser['sub'];
  const userId = scalarClaim(rawUserId);
  if (!isMachine && !userId) {
    throw new UnauthorizedException('The token does not contain a user ID.');
  }

  const roles = getAuthRoles(authUser);
  const scopes = Array.from(
    new Set([
      ...normalizeScopeClaim(authUser['scope']),
      ...normalizeScopeClaim(authUser['scopes']),
    ]),
  );
  const supportRole = SUPPORT_TEAM_ROLE.toLowerCase();

  return {
    handle:
      scalarClaim(authUser['handle'] ?? authUser['preferred_username']) ||
      (isMachine ? 'system' : `member-${userId}`),
    isMachine,
    isSupportTeam: roles.some(
      (role) => role.trim().toLowerCase() === supportRole,
    ),
    roles,
    scopes,
    userId: isMachine ? scalarClaim(authUser['azp']) || 'system' : userId,
  };
}
