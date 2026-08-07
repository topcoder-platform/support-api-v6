import { IdentityService } from '../integrations/identity.service';
import { MemberApiService } from '../integrations/member-api.service';
import { MemberDirectoryService } from './member-directory.service';

describe('MemberDirectoryService', () => {
  it('combines the authoritative Identity snapshot with Member API rating color', async () => {
    const identity = {
      getUserSnapshot: jest.fn().mockResolvedValue({
        email: 'member@example.com',
        handle: 'member_one',
        userId: '1234',
      }),
    };
    const memberApi = {
      getRatingColor: jest.fn().mockResolvedValue('#2D7E2D'),
    };
    const service = new MemberDirectoryService(
      identity as unknown as IdentityService,
      memberApi as unknown as MemberApiService,
    );

    await expect(service.getUserSnapshot('1234', 'fallback')).resolves.toEqual({
      email: 'member@example.com',
      handle: 'member_one',
      handleColor: '#2D7E2D',
      userId: '1234',
    });
    expect(memberApi.getRatingColor).toHaveBeenCalledWith('member_one');
  });
});
