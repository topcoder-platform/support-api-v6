import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  IdentityRoleMember,
  IdentityService,
} from '../integrations/identity.service';
import { MemberApiService } from '../integrations/member-api.service';

export interface MemberSnapshot {
  userId: string;
  handle: string;
  email?: string;
  handleColor?: string;
}

/**
 * Builds stable support-ticket user snapshots from Identity API and enriches
 * handles with the platform rating color from Member API.
 */
@Injectable()
export class MemberDirectoryService {
  private readonly logger = new Logger(MemberDirectoryService.name);

  /**
   * Creates the member-directory facade.
   *
   * @param identity Identity API v6 adapter.
   * @param memberApi Member API v6 rating adapter.
   */
  constructor(
    private readonly identity: IdentityService,
    private readonly memberApi: MemberApiService,
  ) {}

  /**
   * Resolves the snapshot contract consumed by ticket mutations.
   * Identity remains authoritative for handle/email. A trusted caller-provided
   * handle is used only when Identity has no record, while rating enrichment is
   * deliberately best-effort.
   *
   * @param userId Topcoder user ID.
   * @param fallbackHandle authenticated token handle used only as a fallback.
   * @returns user ID, handle, optional email, and optional handle color.
   * @throws NotFoundException when neither Identity nor a fallback handle can identify the user.
   */
  async getUserSnapshot(
    userId: string,
    fallbackHandle?: string,
  ): Promise<MemberSnapshot> {
    const identitySnapshot = await this.identity.getUserSnapshot(userId);
    const handle =
      identitySnapshot?.handle || String(fallbackHandle ?? '').trim();
    if (!handle) {
      throw new NotFoundException('Member profile was not found.');
    }

    let handleColor: string | undefined;
    try {
      handleColor = await this.memberApi.getRatingColor(handle);
    } catch {
      this.logger.warn(
        `Rating-color enrichment failed for user ${String(userId)}.`,
      );
    }
    return {
      userId: identitySnapshot?.userId ?? String(userId),
      handle,
      ...(identitySnapshot?.email ? { email: identitySnapshot.email } : {}),
      ...(handleColor ? { handleColor } : {}),
    };
  }

  /**
   * Compatibility alias for callers that describe the result as a member
   * snapshot rather than a user snapshot.
   *
   * @param userId Topcoder user ID.
   * @param fallbackHandle authenticated handle fallback.
   * @returns the resolved stable member snapshot.
   * @throws NotFoundException when the user cannot be identified.
   */
  async getMemberSnapshot(
    userId: string,
    fallbackHandle?: string,
  ): Promise<MemberSnapshot> {
    return this.getUserSnapshot(userId, fallbackHandle);
  }

  /**
   * Returns all email-bearing members of the exact support-team role.
   *
   * @returns deduplicated Identity role-member snapshots.
   * @throws Identity API, M2M, or missing-role errors.
   */
  async listSupportTeamMembers(): Promise<IdentityRoleMember[]> {
    return this.identity.listSupportTeamMembers();
  }
}
