import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { IdentityService } from './identity.service';
import { M2mService } from './m2m.service';

/** Builds an Identity service around observable HTTP and token doubles. */
function createHarness() {
  const http = { get: jest.fn() };
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        IDENTITY_API_URL: 'https://api.topcoder.com/v6/',
        IDENTITY_ROLE_MEMBER_PAGE_SIZE: '2',
      };
      return values[key];
    }),
  };
  const m2m = { getToken: jest.fn().mockResolvedValue('m2m-token') };
  const service = new IdentityService(
    http as unknown as HttpService,
    config as unknown as ConfigService,
    m2m as unknown as M2mService,
  );
  return { http, m2m, service };
}

describe('IdentityService', () => {
  it('requires the exact support role and paginates every role subject', async () => {
    const { http, service } = createHarness();
    http.get
      .mockReturnValueOnce(
        of({
          data: [
            { id: 77, roleName: 'Topcoder Support Team' },
            { id: 88, roleName: 'Topcoder Support Team Managers' },
          ],
        }),
      )
      .mockReturnValueOnce(
        of({
          data: [
            { email: 'one@example.com', handle: 'support_one', userId: 1 },
            { email: '', handle: 'no_email', userId: 2 },
          ],
          headers: { 'x-total': '3' },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: [
            { email: 'two@example.com', handle: 'support_two', userId: 3 },
          ],
          headers: { 'x-total': '3' },
        }),
      );

    await expect(service.listSupportTeamMembers()).resolves.toEqual([
      { email: 'one@example.com', handle: 'support_one', userId: '1' },
      { email: 'two@example.com', handle: 'support_two', userId: '3' },
    ]);
    expect(http.get).toHaveBeenNthCalledWith(
      1,
      'https://api.topcoder.com/v6/roles',
      {
        headers: { Authorization: 'Bearer m2m-token' },
        params: { filter: 'roleName=Topcoder Support Team' },
      },
    );
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      'https://api.topcoder.com/v6/roles/77/subjects',
      {
        headers: { Authorization: 'Bearer m2m-token' },
        params: { page: 1, perPage: 2 },
      },
    );
    expect(http.get).toHaveBeenNthCalledWith(
      3,
      'https://api.topcoder.com/v6/roles/77/subjects',
      {
        headers: { Authorization: 'Bearer m2m-token' },
        params: { page: 2, perPage: 2 },
      },
    );
  });

  it('returns only the exact user ID selected by an Identity filter', async () => {
    const { http, service } = createHarness();
    http.get.mockReturnValue(
      of({
        data: {
          result: [
            { email: 'wrong@example.com', handle: 'wrong', id: 1235 },
            { email: 'member@example.com', handle: 'member_one', id: 1234 },
          ],
        },
      }),
    );

    await expect(service.getUserSnapshot('1234')).resolves.toEqual({
      email: 'member@example.com',
      handle: 'member_one',
      userId: '1234',
    });
    expect(http.get).toHaveBeenCalledWith('https://api.topcoder.com/v6/users', {
      headers: { Authorization: 'Bearer m2m-token' },
      params: { filter: 'id=1234', selector: 'id,handle,email' },
    });
  });

  it('sanitizes a Support Team role lookup failure to stage and status', async () => {
    const { http, service } = createHarness();
    http.get.mockReturnValue(
      throwError(() =>
        Object.assign(
          new Error('Bearer secret and support-team response body'),
          { response: { status: 403 } },
        ),
      ),
    );

    await expect(service.listSupportTeamMembers()).rejects.toMatchObject({
      safeCode: 'identity_roles_http_403',
    });
  });
});
