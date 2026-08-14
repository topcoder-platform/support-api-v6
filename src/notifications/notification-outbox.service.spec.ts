import { ConfigService } from '@nestjs/config';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { DbService } from '../db/db.service';
import { EventBusService } from '../integrations/event-bus.service';
import { IntegrationDeliveryError } from '../integrations/integration-delivery.error';
import { SlackService } from '../integrations/slack.service';
import { MemberDirectoryService } from './member-directory.service';
import {
  NotificationOutboxService,
  markdownNotificationPreview,
} from './notification-outbox.service';

const lockedAt = new Date('2026-08-07T03:00:00.000Z');
const openedAt = new Date('2026-08-07T01:00:00.000Z');
const closedAt = new Date('2026-08-07T02:00:00.000Z');

/** Creates a complete Prisma-shaped claimed notification record. */
function claimedRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assigneeHandle: null,
    attempts: 1,
    channel: NotificationChannel.EMAIL,
    createdAt: openedAt,
    dedupeKey: 'ticket:ticket-1:opened:email',
    id: 'outbox-1',
    lastError: null,
    lockedAt,
    nextAttemptAt: openedAt,
    response: null,
    responseId: null,
    sentAt: null,
    status: NotificationStatus.PROCESSING,
    ticket: {
      challengeId: 'challenge-1',
      closedAt,
      closedByUserId: 'staff-1',
      createdAt: openedAt,
      description:
        '# Broken upload\nSee [private URL](https://secret.example/path). ' +
        'x'.repeat(500),
      id: 'ticket-1',
      memberHandle: 'member_one',
      memberHandleColor: '#2D7E2D',
      memberUserId: '1001',
      openedAt,
      status: 'OPEN',
      updatedAt: openedAt,
    },
    ticketId: 'ticket-1',
    type: NotificationType.TICKET_OPENED,
    updatedAt: openedAt,
    ...overrides,
  };
}

/** Builds the service and observable database/integration doubles. */
function createHarness() {
  const tx = {
    notificationOutbox: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'outbox-1' }, { id: 'outbox-2' }]),
    },
    supportResponse: {
      findUnique: jest.fn(),
    },
  };
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    notificationOutbox: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        NOTIFICATION_BATCH_SIZE: '20',
        NOTIFICATION_MAX_ATTEMPTS: '3',
        NOTIFICATION_PROCESSING_TIMEOUT_MS: '60000',
        SUPPORT_APP_BASE_URL: 'https://support.topcoder.com/',
      };
      return values[key];
    }),
  };
  const eventBus = {
    sendSupportEmail: jest.fn().mockResolvedValue(undefined),
  };
  const slack = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  const members = {
    getUserSnapshot: jest.fn().mockResolvedValue({
      email: 'member@example.com',
      handle: 'member_one',
      userId: '1001',
    }),
    listSupportTeamMembers: jest.fn().mockResolvedValue([
      { email: 'support-one@example.com', handle: 'support_one', userId: '7' },
      { email: 'support-two@example.com', handle: 'support_two', userId: '8' },
    ]),
  };
  const service = new NotificationOutboxService(
    db as unknown as DbService,
    config as unknown as ConfigService,
    eventBus as unknown as EventBusService,
    slack as unknown as SlackService,
    members as unknown as MemberDirectoryService,
  );
  return { config, db, eventBus, members, service, slack, tx };
}

describe('NotificationOutboxService enqueue', () => {
  it('uses stable unique keys and skipDuplicates for opened and closed channels', async () => {
    const { service, tx } = createHarness();
    const prismaTx = tx as unknown as Prisma.TransactionClient;
    const firstCloseEventId = 'close-event-1';

    await expect(
      service.queueTicketOpened(prismaTx, 'ticket-1'),
    ).resolves.toEqual(['outbox-1', 'outbox-2']);
    await service.queueTicketClosed(prismaTx, 'ticket-1', firstCloseEventId);

    expect(tx.notificationOutbox.createMany).toHaveBeenNthCalledWith(1, {
      data: [
        {
          channel: NotificationChannel.EMAIL,
          dedupeKey: 'ticket:ticket-1:opened:email',
          ticketId: 'ticket-1',
          type: NotificationType.TICKET_OPENED,
        },
        {
          channel: NotificationChannel.SLACK,
          dedupeKey: 'ticket:ticket-1:opened:slack',
          ticketId: 'ticket-1',
          type: NotificationType.TICKET_OPENED,
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.notificationOutbox.createMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            dedupeKey: 'ticket:ticket-1:closed:close-event-1:email',
          }),
          expect.objectContaining({
            dedupeKey: 'ticket:ticket-1:closed:close-event-1:slack',
          }),
        ]),
        skipDuplicates: true,
      }),
    );
  });

  it('uses distinct close-reopen-close keys across lifecycle cycles', async () => {
    const { service, tx } = createHarness();
    const prismaTx = tx as unknown as Prisma.TransactionClient;
    tx.supportResponse.findUnique.mockResolvedValue({
      ticket: { memberUserId: '1001' },
      ticketId: 'ticket-1',
      userId: '1001',
    });

    await service.queueTicketClosed(prismaTx, 'ticket-1', 'close-event-1');
    await service.queueTicketReopened(
      prismaTx,
      'ticket-1',
      'response-reopen-1',
    );
    await service.queueTicketClosed(prismaTx, 'ticket-1', 'close-event-2');

    const dedupeKeys = tx.notificationOutbox.createMany.mock.calls.flatMap(
      ([argument]) =>
        argument.data.map((intent: { dedupeKey: string }) => intent.dedupeKey),
    );
    expect(dedupeKeys).toEqual([
      'ticket:ticket-1:closed:close-event-1:email',
      'ticket:ticket-1:closed:close-event-1:slack',
      'ticket:ticket-1:response:response-reopen-1:reopened:email',
      'ticket:ticket-1:response:response-reopen-1:reopened:slack',
      'ticket:ticket-1:closed:close-event-2:email',
      'ticket:ticket-1:closed:close-event-2:slack',
    ]);
    expect(new Set(dedupeKeys)).toHaveProperty('size', dedupeKeys.length);
  });

  it('queues one Slack intent carrying the assignee handle per assignment', async () => {
    const { service, tx } = createHarness();
    tx.notificationOutbox.findMany.mockResolvedValue([{ id: 'assign-outbox' }]);

    await expect(
      service.queueTicketAssigned(
        tx as unknown as Prisma.TransactionClient,
        'ticket-1',
        'support_one',
        'assign-event-1',
      ),
    ).resolves.toEqual(['assign-outbox']);
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          assigneeHandle: 'support_one',
          channel: NotificationChannel.SLACK,
          dedupeKey: 'ticket:ticket-1:assigned:assign-event-1:slack',
          ticketId: 'ticket-1',
          type: NotificationType.TICKET_ASSIGNED,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('propagates enqueue failure so the surrounding domain transaction rolls back', async () => {
    const { service, tx } = createHarness();
    tx.notificationOutbox.createMany.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      service.queueTicketOpened(
        tx as unknown as Prisma.TransactionClient,
        'ticket-1',
      ),
    ).rejects.toThrow('database unavailable');
  });

  it('queues one member email for a staff reply and none for a member reply', async () => {
    const { service, tx } = createHarness();
    const prismaTx = tx as unknown as Prisma.TransactionClient;
    tx.notificationOutbox.findMany.mockResolvedValue([{ id: 'reply-outbox' }]);
    tx.supportResponse.findUnique
      .mockResolvedValueOnce({
        ticket: { memberUserId: '1001' },
        ticketId: 'ticket-1',
        userId: 'staff-1',
      })
      .mockResolvedValueOnce({
        ticket: { memberUserId: '1001' },
        ticketId: 'ticket-1',
        userId: '1001',
      });

    await expect(
      service.queueTicketReplied(prismaTx, 'ticket-1', 'response-1'),
    ).resolves.toEqual(['reply-outbox']);
    await expect(
      service.queueTicketReplied(prismaTx, 'ticket-1', 'response-2'),
    ).resolves.toEqual([]);

    expect(tx.notificationOutbox.createMany).toHaveBeenCalledTimes(1);
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          channel: NotificationChannel.EMAIL,
          dedupeKey: 'ticket:ticket-1:response:response-1:replied:email',
          responseId: 'response-1',
          ticketId: 'ticket-1',
          type: NotificationType.TICKET_REPLIED,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('queues email and Slack only for a member-owner reopen response', async () => {
    const { service, tx } = createHarness();
    const prismaTx = tx as unknown as Prisma.TransactionClient;
    tx.supportResponse.findUnique.mockResolvedValue({
      ticket: { memberUserId: '1001' },
      ticketId: 'ticket-1',
      userId: '1001',
    });

    await expect(
      service.queueTicketReopened(prismaTx, 'ticket-1', 'response-reopen'),
    ).resolves.toEqual(['outbox-1', 'outbox-2']);
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          channel: NotificationChannel.EMAIL,
          dedupeKey: 'ticket:ticket-1:response:response-reopen:reopened:email',
          responseId: 'response-reopen',
          ticketId: 'ticket-1',
          type: NotificationType.TICKET_REOPENED,
        },
        {
          channel: NotificationChannel.SLACK,
          dedupeKey: 'ticket:ticket-1:response:response-reopen:reopened:slack',
          responseId: 'response-reopen',
          ticketId: 'ticket-1',
          type: NotificationType.TICKET_REOPENED,
        },
      ],
      skipDuplicates: true,
    });

    tx.supportResponse.findUnique.mockResolvedValue({
      ticket: { memberUserId: '1001' },
      ticketId: 'ticket-1',
      userId: 'staff-1',
    });
    await expect(
      service.queueTicketReopened(prismaTx, 'ticket-1', 'response-staff'),
    ).rejects.toThrow('member-owner response');
  });
});

describe('NotificationOutboxService delivery', () => {
  it('atomically claims with skip-locked and delivers opened email and Slack', async () => {
    const { db, eventBus, members, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([
      { id: 'opened-email', lockedAt },
      { id: 'opened-slack', lockedAt },
    ]);
    db.notificationOutbox.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        claimedRecord({
          channel:
            where.id === 'opened-email'
              ? NotificationChannel.EMAIL
              : NotificationChannel.SLACK,
          id: where.id,
        }),
      ),
    );

    await expect(
      service.dispatch(['opened-email', 'opened-slack', 'opened-email']),
    ).resolves.toBeUndefined();

    const query = db.$queryRaw.mock.calls[0][0] as { strings: string[] };
    const sql = query.strings.join(' ');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('UPDATE "support"."notification_outbox"');
    expect(members.listSupportTeamMembers).toHaveBeenCalledTimes(1);
    expect(eventBus.sendSupportEmail).toHaveBeenCalledWith(
      'opened',
      ['support-one@example.com', 'support-two@example.com'],
      expect.objectContaining({
        challengeId: 'challenge-1',
        descriptionPreview: expect.any(String),
        memberHandle: 'member_one',
        ticketId: 'ticket-1',
        ticketUrl: 'https://support.topcoder.com/tickets/ticket-1',
      }),
    );
    const openedData = eventBus.sendSupportEmail.mock.calls[0][2];
    expect(openedData).not.toHaveProperty('description');
    expect(openedData.descriptionPreview).not.toContain('secret.example');
    expect(Array.from(openedData.descriptionPreview)).toHaveLength(320);
    expect(slack.sendNotification).toHaveBeenCalledWith(
      expect.stringContaining('https://support.topcoder.com/tickets/ticket-1'),
    );
    expect(db.notificationOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: NotificationStatus.SENT }),
      }),
    );
  });

  it('posts the opened Slack message on multiple lines with a challenge link and body', async () => {
    const { db, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([{ id: 'opened-slack', lockedAt }]);
    db.notificationOutbox.findUnique.mockResolvedValue(
      claimedRecord({
        channel: NotificationChannel.SLACK,
        dedupeKey: 'ticket:ticket-1:opened:slack',
        id: 'opened-slack',
      }),
    );

    await service.dispatch(['opened-slack']);

    const message = slack.sendNotification.mock.calls[0][0] as string;
    const lines = message.split('\n');
    expect(lines[0]).toBe('New support ticket opened by member_one.');
    expect(lines[1]).toBe(
      'Challenge: <https://work.topcoder.com/challenges/challenge-1|challenge-1>',
    );
    expect(lines[2]).toBe(
      'Ticket: https://support.topcoder.com/tickets/ticket-1',
    );
    expect(lines[3]).toBe('Request:');
    expect(lines[4]).toContain('Broken upload');
    expect(message).not.toContain('secret.example');
  });

  it('omits the challenge line when the ticket has no challenge', async () => {
    const { db, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([{ id: 'opened-slack', lockedAt }]);
    db.notificationOutbox.findUnique.mockImplementation(() => {
      const record = claimedRecord({
        channel: NotificationChannel.SLACK,
        id: 'opened-slack',
      });
      record.ticket = {
        ...(record.ticket as Record<string, unknown>),
        challengeId: null,
      };
      return Promise.resolve(record);
    });

    await service.dispatch(['opened-slack']);

    const message = slack.sendNotification.mock.calls[0][0] as string;
    expect(message).not.toContain('Challenge:');
    expect(message.split('\n')[1]).toBe(
      'Ticket: https://support.topcoder.com/tickets/ticket-1',
    );
  });

  it('posts an assignment Slack message naming the assignee', async () => {
    const { db, eventBus, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([{ id: 'assigned-slack', lockedAt }]);
    db.notificationOutbox.findUnique.mockResolvedValue(
      claimedRecord({
        assigneeHandle: 'support_one',
        channel: NotificationChannel.SLACK,
        dedupeKey: 'ticket:ticket-1:assigned:assign-event-1:slack',
        id: 'assigned-slack',
        type: NotificationType.TICKET_ASSIGNED,
      }),
    );

    await service.dispatch(['assigned-slack']);

    expect(slack.sendNotification).toHaveBeenCalledWith(
      'Support ticket for member_one was assigned to support_one.\n' +
        'Challenge: <https://work.topcoder.com/challenges/challenge-1|challenge-1>\n' +
        'Ticket: https://support.topcoder.com/tickets/ticket-1',
    );
    expect(eventBus.sendSupportEmail).not.toHaveBeenCalled();
  });

  it('fails an assignment Slack row that lost its assignee handle', async () => {
    const { db, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([{ id: 'assigned-slack', lockedAt }]);
    db.notificationOutbox.findUnique.mockResolvedValue(
      claimedRecord({
        channel: NotificationChannel.SLACK,
        id: 'assigned-slack',
        type: NotificationType.TICKET_ASSIGNED,
      }),
    );

    await service.dispatch(['assigned-slack']);

    expect(slack.sendNotification).not.toHaveBeenCalled();
    expect(db.notificationOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('assignee_handle_missing'),
          status: NotificationStatus.FAILED,
        }),
      }),
    );
  });

  it('delivers reply email only to the ticket member with a bounded preview', async () => {
    const { db, eventBus, members, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([{ id: 'reply-email', lockedAt }]);
    db.notificationOutbox.findUnique.mockResolvedValue(
      claimedRecord({
        dedupeKey: 'ticket:ticket-1:response:response-1:replied:email',
        id: 'reply-email',
        response: {
          createdAt: closedAt,
          id: 'response-1',
          markdown: '**Resolved**. [details](https://internal.example/path)',
          ticketId: 'ticket-1',
          userHandle: 'support_one',
          userHandleColor: null,
          userId: 'staff-1',
        },
        responseId: 'response-1',
        type: NotificationType.TICKET_REPLIED,
      }),
    );

    await service.dispatch(['reply-email']);

    expect(members.getUserSnapshot).toHaveBeenCalledWith('1001', 'member_one');
    expect(eventBus.sendSupportEmail).toHaveBeenCalledWith(
      'replied',
      ['member@example.com'],
      expect.objectContaining({
        challengeId: 'challenge-1',
        responderHandle: 'support_one',
        responsePreview: 'Resolved. details',
      }),
    );
    expect(eventBus.sendSupportEmail.mock.calls[0][2]).not.toHaveProperty(
      'responseMarkdown',
    );
    expect(slack.sendNotification).not.toHaveBeenCalled();
  });

  it('delivers reopened email and Slack to Support Team', async () => {
    const { db, eventBus, members, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([
      { id: 'reopened-email', lockedAt },
      { id: 'reopened-slack', lockedAt },
    ]);
    db.notificationOutbox.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        claimedRecord({
          channel:
            where.id === 'reopened-email'
              ? NotificationChannel.EMAIL
              : NotificationChannel.SLACK,
          dedupeKey: `ticket:ticket-1:response:response-reopen:reopened:${
            where.id === 'reopened-email' ? 'email' : 'slack'
          }`,
          id: where.id,
          response: {
            createdAt: closedAt,
            id: 'response-reopen',
            markdown:
              '**It happened again**. [private](https://secret.example)',
            ticketId: 'ticket-1',
            userHandle: 'member_one',
            userHandleColor: null,
            userId: '1001',
          },
          responseId: 'response-reopen',
          type: NotificationType.TICKET_REOPENED,
        }),
      ),
    );

    await service.dispatch(['reopened-email', 'reopened-slack']);

    expect(members.listSupportTeamMembers).toHaveBeenCalledTimes(1);
    expect(eventBus.sendSupportEmail).toHaveBeenCalledWith(
      'reopened',
      ['support-one@example.com', 'support-two@example.com'],
      expect.objectContaining({
        challengeId: 'challenge-1',
        memberHandle: 'member_one',
        reopenedAt: closedAt.toISOString(),
        responsePreview: 'It happened again. private',
        ticketId: 'ticket-1',
      }),
    );
    expect(eventBus.sendSupportEmail.mock.calls[0][2]).not.toHaveProperty(
      'responseMarkdown',
    );
    expect(slack.sendNotification).toHaveBeenCalledWith(
      expect.stringContaining('reopened by member_one'),
    );
  });

  it('delivers closed member email and Slack, without emailing staff', async () => {
    const { db, eventBus, service, slack } = createHarness();
    db.$queryRaw.mockResolvedValue([
      { id: 'closed-email', lockedAt },
      { id: 'closed-slack', lockedAt },
    ]);
    db.notificationOutbox.findUnique.mockImplementation(({ where }) => {
      const record = claimedRecord({
        channel:
          where.id === 'closed-email'
            ? NotificationChannel.EMAIL
            : NotificationChannel.SLACK,
        dedupeKey: `ticket:ticket-1:closed:${
          where.id === 'closed-email' ? 'email' : 'slack'
        }`,
        createdAt: closedAt,
        id: where.id,
        type: NotificationType.TICKET_CLOSED,
      });
      record.ticket = {
        ...(record.ticket as Record<string, unknown>),
        closedAt: new Date('2026-08-07T05:00:00.000Z'),
      };
      return Promise.resolve(record);
    });

    await service.dispatch(['closed-email', 'closed-slack']);

    expect(eventBus.sendSupportEmail).toHaveBeenCalledWith(
      'closed',
      ['member@example.com'],
      expect.objectContaining({
        challengeId: 'challenge-1',
        closedAt: closedAt.toISOString(),
        descriptionPreview: expect.any(String),
      }),
    );
    expect(slack.sendNotification).toHaveBeenCalledWith(
      expect.stringContaining('was closed'),
    );
  });

  it.each([
    [1, NotificationStatus.FAILED],
    [3, NotificationStatus.DEAD],
  ])('records failed attempt %s as %s', async (attempts, expectedStatus) => {
    const { db, eventBus, service } = createHarness();
    db.$queryRaw.mockResolvedValue([{ id: 'failed-email', lockedAt }]);
    db.notificationOutbox.findUnique.mockResolvedValue(
      claimedRecord({ attempts, id: 'failed-email' }),
    );
    eventBus.sendSupportEmail.mockRejectedValue(
      new IntegrationDeliveryError('bus_api_http_403'),
    );

    await expect(service.dispatch(['failed-email'])).resolves.toBeUndefined();

    expect(db.notificationOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('bus_api_http_403'),
          status: expectedStatus,
        }),
        where: expect.objectContaining({
          id: 'failed-email',
          lockedAt,
          status: NotificationStatus.PROCESSING,
        }),
      }),
    );
  });
});

describe('markdownNotificationPreview', () => {
  it('removes markdown URLs and bounds Unicode without splitting an emoji', () => {
    const preview = markdownNotificationPreview(
      '# Heading [label](https://secret.example) <b>text</b> 😀😀😀😀',
      22,
    );

    expect(preview).toBe('Heading label text 😀😀…');
    expect(Array.from(preview).length).toBeLessThanOrEqual(22);
    expect(preview).not.toContain('secret.example');
  });
});
