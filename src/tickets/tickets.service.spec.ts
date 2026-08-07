import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { SupportActor } from '../auth/auth.types';
import { DbService } from '../db/db.service';
import { MemberDirectoryService } from '../notifications/member-directory.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { TicketsService } from './tickets.service';

const openedAt = new Date('2026-08-07T01:00:00.000Z');

/**
 * Creates an authenticated actor with stable member defaults.
 *
 * @param overrides actor fields that should differ for a test.
 * @returns a normalized support actor.
 */
function createActor(overrides: Partial<SupportActor> = {}): SupportActor {
  return {
    handle: 'member_one',
    isMachine: false,
    isSupportTeam: false,
    roles: ['Topcoder User'],
    scopes: [],
    userId: 'member-1',
    ...overrides,
  };
}

/**
 * Creates the Prisma-shaped ticket projection consumed by service mappers.
 *
 * @param overrides record fields that should differ for a test.
 * @returns a complete ticket detail projection test double.
 */
function createTicketRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _count: { responses: 0 },
    assignees: [],
    challengeId: null,
    closedAt: null,
    description: 'The challenge submission is unavailable.',
    id: 'ticket-1',
    memberHandle: 'member_one',
    memberHandleColor: '#2D7E2D',
    memberUserId: 'member-1',
    openedAt,
    readStates: [
      {
        lastReadAt: openedAt,
        ticketId: 'ticket-1',
        userId: 'member-1',
      },
    ],
    responses: [],
    status: TicketStatus.OPEN,
    updatedAt: openedAt,
    ...overrides,
  };
}

/**
 * Builds isolated database, directory, and outbox mocks around the real service.
 *
 * @returns a ticket service and its observable test doubles.
 */
function createHarness() {
  const tx = {
    responseReadReceipt: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    supportResponse: {
      create: jest.fn().mockResolvedValue({ id: 'response-1' }),
    },
    supportTicket: {
      create: jest.fn().mockResolvedValue({ id: 'ticket-1' }),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ticketAssignee: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn(),
    },
    ticketReadState: {
      upsert: jest.fn(),
    },
  };
  const db = {
    $transaction: jest.fn(),
    supportTicket: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(createTicketRecord()),
    },
  };
  db.$transaction.mockImplementation(async (operation: unknown) => {
    if (Array.isArray(operation)) {
      return Promise.all(operation);
    }
    return (operation as (client: typeof tx) => Promise<unknown>)(tx);
  });

  const memberDirectory = {
    getUserSnapshot: jest.fn((userId: string, fallbackHandle?: string) => ({
      email: `${userId}@example.test`,
      handle: fallbackHandle ?? userId,
      handleColor: '#616BD5',
      userId,
    })),
  };
  const notificationOutbox = {
    dispatch: jest.fn().mockResolvedValue(undefined),
    queueTicketClosed: jest.fn().mockResolvedValue([]),
    queueTicketOpened: jest.fn().mockResolvedValue([]),
    queueTicketReplied: jest.fn().mockResolvedValue([]),
  };
  const service = new TicketsService(
    db as unknown as DbService,
    memberDirectory as unknown as MemberDirectoryService,
    notificationOutbox as unknown as NotificationOutboxService,
  );

  return { db, memberDirectory, notificationOutbox, service, tx };
}

const member = createActor();
const support = createActor({
  handle: 'support_one',
  isSupportTeam: true,
  roles: ['Topcoder Support Team'],
  userId: 'staff-1',
});

describe('TicketsService', () => {
  it('always ownership-scopes an ordinary member list', async () => {
    const { db, service } = createHarness();
    db.supportTicket.count.mockResolvedValue(1);
    db.supportTicket.findMany.mockResolvedValue([createTicketRecord()]);

    const result = await service.list(member, {
      challengeId: 'ignored-challenge',
      description: 'ignored description',
      memberHandle: 'ignored_handle',
      page: 2,
      perPage: 10,
      status: TicketStatus.OPEN,
    });

    expect(db.supportTicket.count).toHaveBeenCalledWith({
      where: {
        memberUserId: member.userId,
        status: TicketStatus.OPEN,
      },
    });
    expect(db.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: {
          memberUserId: member.userId,
          status: TicketStatus.OPEN,
        },
      }),
    );
    expect(result.meta).toEqual({
      page: 2,
      perPage: 10,
      totalCount: 1,
      totalPages: 1,
    });
  });

  it('lets support list globally with all supported search filters', async () => {
    const { db, service } = createHarness();

    await service.list(support, {
      challengeId: 'challenge-42',
      description: 'submission',
      memberHandle: 'Member_One',
      page: 1,
      perPage: 20,
      status: TicketStatus.CLOSED,
    });

    const expectedWhere = {
      challengeId: 'challenge-42',
      description: { contains: 'submission', mode: 'insensitive' },
      memberHandle: { equals: 'Member_One', mode: 'insensitive' },
      status: TicketStatus.CLOSED,
    };
    expect(db.supportTicket.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
    expect(db.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(db.supportTicket.findMany.mock.calls[0][0].where).not.toHaveProperty(
      'memberUserId',
    );
  });

  it('forbids an ordinary member from reading another member ticket', async () => {
    const { db, service } = createHarness();
    db.supportTicket.findUnique.mockResolvedValue(
      createTicketRecord({ memberUserId: 'member-2' }),
    );

    await expect(service.getById(member, 'ticket-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('queues ticket-opened intents in the transaction and dispatches after commit', async () => {
    const { db, memberDirectory, notificationOutbox, service, tx } =
      createHarness();
    const events: string[] = [];
    db.$transaction.mockImplementationOnce(
      async (operation: (client: typeof tx) => Promise<unknown>) => {
        events.push('transaction-started');
        const result = await operation(tx);
        events.push('transaction-committed');
        return result;
      },
    );
    tx.supportTicket.create.mockImplementationOnce(() => {
      events.push('ticket-created');
      return Promise.resolve({ id: 'ticket-1' });
    });
    notificationOutbox.queueTicketOpened.mockImplementationOnce(() => {
      events.push('notification-queued');
      return Promise.resolve(['opened-email', 'opened-slack']);
    });
    notificationOutbox.dispatch.mockImplementationOnce(() => {
      events.push('notification-dispatched');
      return Promise.resolve();
    });

    await service.create(member, {
      challengeId: 'challenge-42',
      description: 'Please restore the submission.',
    });

    expect(memberDirectory.getUserSnapshot).toHaveBeenCalledWith(
      member.userId,
      member.handle,
    );
    expect(notificationOutbox.queueTicketOpened).toHaveBeenCalledWith(
      tx,
      'ticket-1',
    );
    expect(notificationOutbox.dispatch).toHaveBeenCalledWith([
      'opened-email',
      'opened-slack',
    ]);
    expect(events).toEqual([
      'transaction-started',
      'ticket-created',
      'notification-queued',
      'transaction-committed',
      'notification-dispatched',
    ]);
  });

  it('does not queue a member-authored reply notification', async () => {
    const { notificationOutbox, service, tx } = createHarness();
    tx.supportTicket.findUnique.mockResolvedValue({
      memberUserId: member.userId,
      status: TicketStatus.OPEN,
    });

    await service.addResponse(member, 'ticket-1', {
      markdown: 'Here is the requested reproduction detail.',
    });

    expect(tx.supportResponse.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          markdown: 'Here is the requested reproduction detail.',
          userId: member.userId,
        }),
      }),
    );
    expect(notificationOutbox.queueTicketReplied).not.toHaveBeenCalled();
    expect(notificationOutbox.dispatch).not.toHaveBeenCalled();
  });

  it('queues and dispatches the member email for a support-authored reply', async () => {
    const { notificationOutbox, service, tx } = createHarness();
    tx.supportTicket.findUnique.mockResolvedValue({
      memberUserId: member.userId,
      status: TicketStatus.OPEN,
    });
    tx.supportResponse.create.mockResolvedValue({ id: 'response-2' });
    notificationOutbox.queueTicketReplied.mockResolvedValue(['reply-email']);

    await service.addResponse(support, 'ticket-1', {
      markdown: 'The issue has been reproduced by support.',
    });

    expect(notificationOutbox.queueTicketReplied).toHaveBeenCalledWith(
      tx,
      'ticket-1',
      'response-2',
    );
    expect(notificationOutbox.dispatch).toHaveBeenCalledWith(['reply-email']);
  });

  it('rejects replies to a closed ticket before writing or notifying', async () => {
    const { notificationOutbox, service, tx } = createHarness();
    tx.supportTicket.findUnique.mockResolvedValue({
      memberUserId: member.userId,
      status: TicketStatus.CLOSED,
    });

    await expect(
      service.addResponse(member, 'ticket-1', { markdown: 'One more detail.' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.supportResponse.create).not.toHaveBeenCalled();
    expect(notificationOutbox.queueTicketReplied).not.toHaveBeenCalled();
  });

  it('rejects assignment to a closed ticket', async () => {
    const { service, tx } = createHarness();
    tx.supportTicket.findUnique.mockResolvedValue({
      assignees: [],
      status: TicketStatus.CLOSED,
    });

    await expect(
      service.assignToMe(support, 'ticket-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.ticketAssignee.upsert).not.toHaveBeenCalled();
  });

  it('role-gates both assignment and ticket closure', async () => {
    const { db, memberDirectory, service } = createHarness();

    await expect(service.assignToMe(member, 'ticket-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.close(member, 'ticket-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(memberDirectory.getUserSnapshot).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('treats an already-closed ticket as idempotent without enqueueing again', async () => {
    const { db, notificationOutbox, service, tx } = createHarness();
    const closedAt = new Date('2026-08-07T02:00:00.000Z');
    tx.supportTicket.findUnique.mockResolvedValue({
      status: TicketStatus.CLOSED,
    });
    db.supportTicket.findUnique.mockResolvedValue(
      createTicketRecord({ closedAt, status: TicketStatus.CLOSED }),
    );

    const result = await service.close(support, 'ticket-1');

    expect(result.status).toBe(TicketStatus.CLOSED);
    expect(tx.supportTicket.updateMany).not.toHaveBeenCalled();
    expect(notificationOutbox.queueTicketClosed).not.toHaveBeenCalled();
    expect(notificationOutbox.dispatch).not.toHaveBeenCalled();
  });

  it('marks the ticket and every current response receipt read', async () => {
    const { service, tx } = createHarness();
    tx.supportTicket.findUnique.mockResolvedValue({
      memberUserId: member.userId,
      responses: [{ id: 'response-1' }, { id: 'response-2' }],
    });

    const result = await service.markRead(member, 'ticket-1');

    expect(tx.ticketReadState.upsert).toHaveBeenCalledWith({
      create: {
        lastReadAt: result.readAt,
        ticketId: 'ticket-1',
        userId: member.userId,
      },
      update: { lastReadAt: result.readAt },
      where: {
        ticketId_userId: {
          ticketId: 'ticket-1',
          userId: member.userId,
        },
      },
    });
    expect(tx.responseReadReceipt.createMany).toHaveBeenCalledWith({
      data: [
        {
          readAt: result.readAt,
          responseId: 'response-1',
          userId: member.userId,
        },
        {
          readAt: result.readAt,
          responseId: 'response-2',
          userId: member.userId,
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.responseReadReceipt.updateMany).toHaveBeenCalledWith({
      data: { readAt: result.readAt },
      where: {
        responseId: { in: ['response-1', 'response-2'] },
        userId: member.userId,
      },
    });
  });
});
