import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { M2mService } from './m2m.service';

/** Reads public handle presentation metadata from Member API v6. */
@Injectable()
export class MemberApiService {
  /**
   * Creates the Member API adapter.
   *
   * @param http HTTP client used for Member API requests.
   * @param config application configuration containing MEMBER_API_URL.
   * @param m2m shared M2M token provider.
   */
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly m2m: M2mService,
  ) {}

  /**
   * Resolves the platform rating color for a member handle.
   *
   * @param handle exact Topcoder handle resolved from Identity API.
   * @returns the rating color, or undefined when the member has no max rating.
   * @throws HTTP and authentication errors from Member API.
   */
  async getRatingColor(handle: string): Promise<string | undefined> {
    const token = await this.m2m.getToken();
    const response = await firstValueFrom(
      this.http.get(`${this.memberBaseUrl()}/${encodeURIComponent(handle)}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'handle,maxRating' },
      }),
    );
    const record = this.extractMemberRecord(response.data);
    const maxRating = this.isRecord(record['maxRating'])
      ? record['maxRating']
      : undefined;
    const candidate = maxRating?.['ratingColor'] ?? record['ratingColor'];
    const ratingColor =
      typeof candidate === 'string' ? candidate.trim() : undefined;
    return ratingColor || undefined;
  }

  /**
   * Normalizes MEMBER_API_URL to the `/v6/members` collection base.
   *
   * @returns an absolute member collection URL without a trailing slash.
   */
  private memberBaseUrl(): string {
    const configured =
      this.config.get<string>('MEMBER_API_URL')?.trim() ||
      'https://api.topcoder-dev.com/v6/members';
    const base = configured.replace(/\/+$/, '');
    return base.endsWith('/members') ? base : `${base}/members`;
  }

  /**
   * Extracts a member record from direct and common wrapped response shapes.
   *
   * @param data raw Member API response.
   * @returns a member record or an empty object.
   */
  private extractMemberRecord(data: unknown): Record<string, unknown> {
    if (this.isRecord(data)) {
      for (const key of ['result', 'data', 'content']) {
        const nested = data[key];
        if (Array.isArray(nested) && this.isRecord(nested[0])) {
          return nested[0];
        }
        if (this.isRecord(nested)) {
          return nested;
        }
      }
      return data;
    }
    if (Array.isArray(data) && this.isRecord(data[0])) {
      return data[0];
    }
    return {};
  }

  /**
   * Checks whether an unknown value is a keyed object.
   *
   * @param value candidate value.
   * @returns true for non-array objects.
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
