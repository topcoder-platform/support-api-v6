import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { M2mService } from './m2m.service';

export const SUPPORT_TEAM_ROLE_NAME = 'Topcoder Support Team';

export interface IdentityUserSnapshot {
  userId: string;
  handle: string;
  email?: string;
}

export interface IdentityRoleMember extends IdentityUserSnapshot {
  email: string;
}

interface IdentityRoleRecord {
  id?: string | number;
  roleName?: string;
}

/**
 * Reads user and exact-role membership snapshots from Identity API v6 using
 * an M2M token with `read:roles` access.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  /**
   * Creates the Identity API adapter.
   *
   * @param http HTTP client used for Identity API requests.
   * @param config application configuration containing IDENTITY_API_URL.
   * @param m2m shared M2M token provider.
   */
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly m2m: M2mService,
  ) {}

  /**
   * Loads one exact Identity user snapshot by numeric user ID.
   *
   * @param userId Topcoder user ID.
   * @returns the exact matching user snapshot, or undefined when not found.
   * @throws HTTP and authentication errors from the Identity API call.
   */
  async getUserSnapshot(
    userId: string,
  ): Promise<IdentityUserSnapshot | undefined> {
    const normalizedUserId = this.numericUserId(userId);
    const response = await firstValueFrom(
      this.http.get(this.buildUrl('/users'), {
        headers: await this.authorizationHeaders(),
        params: {
          filter: `id=${normalizedUserId}`,
          selector: 'id,handle,email',
        },
      }),
    );
    const records = this.extractRecords(response.data);
    const exact = records.find(
      (record) => this.scalarString(record['id']) === normalizedUserId,
    );
    return exact ? this.toUserSnapshot(exact) : undefined;
  }

  /**
   * Resolves the exact `Topcoder Support Team` role and returns all role
   * subjects with usable email addresses.
   *
   * @returns deduplicated role members ordered by Identity API pagination.
   * @throws HTTP and authentication errors or an error when the role is absent.
   */
  async listSupportTeamMembers(): Promise<IdentityRoleMember[]> {
    const token = await this.m2m.getToken();
    const roleResponse = await firstValueFrom(
      this.http.get(this.buildUrl('/roles'), {
        headers: { Authorization: `Bearer ${token}` },
        params: { filter: `roleName=${SUPPORT_TEAM_ROLE_NAME}` },
      }),
    );
    const roles = this.extractRecords(
      roleResponse.data,
    ) as IdentityRoleRecord[];
    const exactRoles = roles.filter(
      (role) => role.roleName === SUPPORT_TEAM_ROLE_NAME,
    );
    if (exactRoles.length === 0 || exactRoles[0].id === undefined) {
      throw new Error('Topcoder Support Team role was not found.');
    }
    if (exactRoles.length > 1) {
      this.logger.warn('Multiple exact support-team roles were returned.');
    }

    return this.listRoleSubjects(String(exactRoles[0].id), token);
  }

  /**
   * Paginates every subject assigned to one Identity role.
   *
   * @param roleId Identity role ID.
   * @param token M2M bearer token reused across all pages.
   * @returns normalized, email-bearing role members.
   * @throws HTTP errors raised by any subjects page.
   */
  private async listRoleSubjects(
    roleId: string,
    token: string,
  ): Promise<IdentityRoleMember[]> {
    const perPage = this.positiveInteger(
      this.config.get<string>('IDENTITY_ROLE_MEMBER_PAGE_SIZE'),
      200,
      1000,
    );
    const membersByUserId = new Map<string, IdentityRoleMember>();
    let page = 1;
    let expectedTotal: number | undefined;

    while (
      expectedTotal === undefined ||
      membersByUserId.size < expectedTotal
    ) {
      const response = await firstValueFrom(
        this.http.get(
          this.buildUrl(`/roles/${encodeURIComponent(roleId)}/subjects`),
          {
            headers: { Authorization: `Bearer ${token}` },
            params: { page, perPage },
          },
        ),
      );
      const records = this.extractRecords(response.data);
      for (const record of records) {
        const snapshot = this.toUserSnapshot(record);
        if (snapshot?.email) {
          membersByUserId.set(snapshot.userId, {
            ...snapshot,
            email: snapshot.email,
          });
        }
      }

      const totalHeader = response.headers?.['x-total'];
      const parsedTotal = Number(totalHeader);
      if (Number.isFinite(parsedTotal) && parsedTotal >= 0) {
        expectedTotal = parsedTotal;
      }
      if (records.length < perPage || records.length === 0) {
        break;
      }
      page += 1;
    }
    return Array.from(membersByUserId.values());
  }

  /**
   * Builds bearer headers for one Identity API request.
   *
   * @returns an Authorization header using the shared M2M token.
   * @throws token-provider errors.
   */
  private async authorizationHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.m2m.getToken()}` };
  }

  /**
   * Builds an absolute Identity v6 URL.
   *
   * @param path path below the v6 base.
   * @returns absolute request URL.
   */
  private buildUrl(path: string): string {
    const configured =
      this.config.get<string>('IDENTITY_API_URL')?.trim() ||
      'https://api.topcoder-dev.com/v6';
    const base = configured.replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * Normalizes common direct and wrapped Topcoder list responses.
   *
   * @param data raw response body.
   * @returns response records, or an empty list.
   */
  private extractRecords(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data)) {
      return data.filter((value): value is Record<string, unknown> =>
        this.isRecord(value),
      );
    }
    if (!this.isRecord(data)) {
      return [];
    }
    for (const key of ['result', 'data', 'content']) {
      const nested = data[key];
      if (Array.isArray(nested)) {
        return nested.filter((value): value is Record<string, unknown> =>
          this.isRecord(value),
        );
      }
    }
    return [];
  }

  /**
   * Converts an Identity response record to a usable user snapshot.
   *
   * @param record Identity user or role-subject record.
   * @returns normalized snapshot, or undefined when ID/handle is missing.
   */
  private toUserSnapshot(
    record: Record<string, unknown>,
  ): IdentityUserSnapshot | undefined {
    const userId = this.scalarString(record['id'] ?? record['userId']);
    const handle = this.scalarString(record['handle']);
    const email = this.scalarString(record['email']).toLowerCase();
    if (!userId || !handle) {
      return undefined;
    }
    return { userId, handle, ...(email ? { email } : {}) };
  }

  /**
   * Validates a Topcoder numeric user ID before placing it in a filter.
   *
   * @param userId candidate user ID.
   * @returns normalized numeric ID.
   * @throws Error for a non-numeric ID.
   */
  private numericUserId(userId: string): string {
    const normalized = String(userId).trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Error('Topcoder user ID must be numeric.');
    }
    return normalized;
  }

  /**
   * Converts only safe scalar API fields to text, avoiding object coercion.
   *
   * @param value unknown response field.
   * @returns a trimmed scalar string, or an empty string for other values.
   */
  private scalarString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'bigint') {
      return String(value);
    }
    return '';
  }

  /**
   * Parses a bounded positive integer configuration value.
   *
   * @param value candidate value.
   * @param fallback fallback when invalid.
   * @param maximum upper bound.
   * @returns a bounded positive integer.
   */
  private positiveInteger(
    value: unknown,
    fallback: number,
    maximum: number,
  ): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0
      ? Math.min(parsed, maximum)
      : fallback;
  }

  /**
   * Checks whether an unknown value is a non-array object.
   *
   * @param value candidate value.
   * @returns true for keyed objects.
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
