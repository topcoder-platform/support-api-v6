import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { SupportActor } from '../auth/auth.types';
import { DbService } from '../db/db.service';
import { MemberDirectoryService } from '../notifications/member-directory.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import {
  CreateResponseDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  MarkReadResponseDto,
  ReadReceiptDto,
  TicketAssigneeDto,
  TicketDetailDto,
  TicketMessageDto,
  TicketPageDto,
  TicketSummaryDto,
} from './dto';

const summaryInclude = Prisma.validator<Prisma.SupportTicketInclude>()({
  _count: { select: { responses: true } },
  assignees: { orderBy: [{ assignedAt: 'asc' }, { userId: 'asc' }] },
  readStates: true,
  responses: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
    take: 1,
  },
});

const detailInclude = Prisma.validator<Prisma.SupportTicketInclude>()({
  _count: { select: { responses: true } },
  assignees: { orderBy: [{ assignedAt: 'asc' }, { userId: 'asc' }] },
  readStates: { orderBy: [{ lastReadAt: 'asc' }, { userId: 'asc' }] },
  responses: {
    include: {
      readReceipts: { orderBy: [{ readAt: 'asc' }, { userId: 'asc' }] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
});

type TicketSummaryRecord = Prisma.SupportTicketGetPayload<{
  include: typeof summaryInclude;
}>;

type TicketDetailRecord = Prisma.SupportTicketGetPayload<{
  include: typeof detailInclude;
}>;

/**
 * Implements ownership-safe support ticket workflows and their transactional
 * notification boundaries.
 *
 * Controllers pass only normalized authenticated actors into this service.
 * Every read and mutation rechecks ownership or the exact Support Team role,
 * while notification intents are queued inside the domain transaction and
 * dispatched only after that transaction commits.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  /**
   * Creates the ticket service.
   *
   * @param db Prisma-backed support database.
   * @param memberDirectory member snapshot resolver used before persistence.
   * @param notificationOutbox transactional notification intent publisher.
   * @throws Does not throw directly; Nest resolves all dependencies.
   */
  constructor(
    private readonly db: DbService,
    private readonly memberDirectory: MemberDirectoryService,
    private readonly notificationOutbox: NotificationOutboxService,
  ) {}

  /**
   * Opens a support ticket for the authenticated member.
   *
   * @param actor authenticated human member opening the request.
   * @param dto validated challenge and markdown description fields.
   * @returns the newly persisted, caller-authorized ticket detail.
   * @throws Errors raised when the member snapshot or database write fails.
   */
  async create(
    actor: SupportActor,
    dto: CreateTicketDto,
  ): Promise<TicketDetailDto> {
    const snapshot = await this.memberDirectory.getUserSnapshot(
      actor.userId,
      actor.handle,
    );
    const transactionResult = await this.db.$transaction(async (tx) => {
      const openedAt = new Date();
      const ticket = await tx.supportTicket.create({
        data: {
          challengeId: dto.challengeId,
          description: dto.description,
          memberHandle: snapshot.handle,
          memberHandleColor: snapshot.handleColor,
          memberUserId: actor.userId,
          openedAt,
          readStates: {
            create: {
              lastReadAt: openedAt,
              userId: actor.userId,
            },
          },
        },
        select: { id: true },
      });
      const notificationIds = await this.notificationOutbox.queueTicketOpened(
        tx,
        ticket.id,
      );
      return { notificationIds, ticketId: ticket.id };
    });

    await this.dispatchAfterCommit(transactionResult.notificationIds);
    return this.getById(actor, transactionResult.ticketId);
  }

  /**
   * Lists support tickets visible to the authenticated actor.
   *
   * Ordinary members are always constrained by their token user ID. Support
   * Team actors can search the complete ticket collection using the supplied
   * status, member handle, challenge, and description filters.
   *
   * @param actor authenticated human requesting the page.
   * @param query validated filters and pagination values.
   * @returns an authorized page of ticket summaries and pagination metadata.
   * @throws Database errors when count or list queries fail.
   */
  async list(
    actor: SupportActor,
    query: ListTicketsQueryDto,
  ): Promise<TicketPageDto> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;
    const where: Prisma.SupportTicketWhereInput = {
      status: query.status ?? TicketStatus.OPEN,
    };

    if (!actor.isSupportTeam) {
      where.memberUserId = actor.userId;
    } else {
      if (query.memberHandle) {
        where.memberHandle = {
          equals: query.memberHandle,
          mode: 'insensitive',
        };
      }
      if (query.challengeId) {
        where.challengeId = query.challengeId;
      }
      if (query.description) {
        where.description = {
          contains: query.description,
          mode: 'insensitive',
        };
      }
    }

    const [totalCount, records] = await this.db.$transaction([
      this.db.supportTicket.count({ where }),
      this.db.supportTicket.findMany({
        include: summaryInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
        where,
      }),
    ]);

    return {
      data: records.map((record) => this.toSummary(record, actor.userId)),
      meta: {
        page,
        perPage,
        totalCount,
        totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / perPage),
      },
    };
  }

  /**
   * Loads one ticket after enforcing owner-or-Support-Team access.
   *
   * @param actor authenticated human requesting the ticket.
   * @param ticketId support ticket UUID.
   * @returns full ticket detail with chronological responses and read receipts.
   * @throws NotFoundException when the ticket does not exist.
   * @throws ForbiddenException when a non-staff actor does not own the ticket.
   */
  async getById(
    actor: SupportActor,
    ticketId: string,
  ): Promise<TicketDetailDto> {
    const record = await this.db.supportTicket.findUnique({
      include: detailInclude,
      where: { id: ticketId },
    });
    if (!record) {
      throw new NotFoundException('Support ticket not found.');
    }
    this.assertCanAccess(actor, record.memberUserId);
    return this.toDetail(record, actor.userId);
  }

  /**
   * Adds a chronological markdown response to an open ticket.
   *
   * The response author is marked as having read their new response. Support
   * Team responses queue an email intent for the member in the same transaction;
   * member responses intentionally do not queue that email.
   *
   * @param actor authenticated owner or Support Team responder.
   * @param ticketId target support ticket UUID.
   * @param dto validated markdown response body.
   * @returns updated full ticket detail.
   * @throws NotFoundException when the ticket does not exist.
   * @throws ForbiddenException when the actor cannot access the ticket.
   * @throws ConflictException when the ticket is already closed.
   */
  async addResponse(
    actor: SupportActor,
    ticketId: string,
    dto: CreateResponseDto,
  ): Promise<TicketDetailDto> {
    const snapshot = await this.memberDirectory.getUserSnapshot(
      actor.userId,
      actor.handle,
    );
    const notificationIds = await this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        select: { memberUserId: true, status: true },
        where: { id: ticketId },
      });
      if (!ticket) {
        throw new NotFoundException('Support ticket not found.');
      }
      this.assertCanAccess(actor, ticket.memberUserId);
      if (ticket.status === TicketStatus.CLOSED) {
        throw new ConflictException(
          'Closed support tickets cannot be updated.',
        );
      }

      const createdAt = new Date();
      const openUpdate = await tx.supportTicket.updateMany({
        data: { updatedAt: createdAt },
        where: { id: ticketId, status: TicketStatus.OPEN },
      });
      if (openUpdate.count !== 1) {
        throw new ConflictException(
          'Closed support tickets cannot be updated.',
        );
      }

      const response = await tx.supportResponse.create({
        data: {
          createdAt,
          markdown: dto.markdown,
          readReceipts: {
            create: { readAt: createdAt, userId: actor.userId },
          },
          ticketId,
          userHandle: snapshot.handle,
          userHandleColor: snapshot.handleColor,
          userId: actor.userId,
        },
        select: { id: true },
      });
      await tx.ticketReadState.upsert({
        create: { lastReadAt: createdAt, ticketId, userId: actor.userId },
        update: { lastReadAt: createdAt },
        where: { ticketId_userId: { ticketId, userId: actor.userId } },
      });

      if (actor.isSupportTeam && actor.userId !== ticket.memberUserId) {
        return this.notificationOutbox.queueTicketReplied(
          tx,
          ticketId,
          response.id,
        );
      }
      return [];
    });

    await this.dispatchAfterCommit(notificationIds);
    return this.getById(actor, ticketId);
  }

  /**
   * Adds the authenticated Support Team member to an open ticket's assignees.
   *
   * The composite ticket/user key and Prisma upsert make repeated assignment
   * calls idempotent while preserving the original assignment timestamp.
   *
   * @param actor authenticated Support Team member assigning themselves.
   * @param ticketId target support ticket UUID.
   * @returns updated full ticket detail.
   * @throws ForbiddenException when the actor lacks the Support Team role.
   * @throws NotFoundException when the ticket does not exist.
   * @throws ConflictException when the ticket is closed.
   */
  async assignToMe(
    actor: SupportActor,
    ticketId: string,
  ): Promise<TicketDetailDto> {
    this.assertSupportTeam(actor);
    const snapshot = await this.memberDirectory.getUserSnapshot(
      actor.userId,
      actor.handle,
    );

    await this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        select: {
          assignees: {
            select: { userId: true },
            where: { userId: actor.userId },
          },
          status: true,
        },
        where: { id: ticketId },
      });
      if (!ticket) {
        throw new NotFoundException('Support ticket not found.');
      }
      if (ticket.status === TicketStatus.CLOSED) {
        throw new ConflictException(
          'Closed support tickets cannot be assigned.',
        );
      }
      if (ticket.assignees.length > 0) {
        return;
      }

      const assignedAt = new Date();
      const openUpdate = await tx.supportTicket.updateMany({
        data: { updatedAt: assignedAt },
        where: { id: ticketId, status: TicketStatus.OPEN },
      });
      if (openUpdate.count !== 1) {
        throw new ConflictException(
          'Closed support tickets cannot be assigned.',
        );
      }
      await tx.ticketAssignee.upsert({
        create: {
          assignedAt,
          assignedByUserId: actor.userId,
          handle: snapshot.handle,
          handleColor: snapshot.handleColor,
          ticketId,
          userId: actor.userId,
        },
        update: {
          handle: snapshot.handle,
          handleColor: snapshot.handleColor,
        },
        where: { ticketId_userId: { ticketId, userId: actor.userId } },
      });
    });

    return this.getById(actor, ticketId);
  }

  /**
   * Removes the authenticated Support Team member from a ticket's assignees.
   *
   * Deleting a missing assignment succeeds without changing data, making the
   * endpoint idempotent for open tickets.
   *
   * @param actor authenticated Support Team member removing themselves.
   * @param ticketId target support ticket UUID.
   * @returns updated full ticket detail.
   * @throws ForbiddenException when the actor lacks the Support Team role.
   * @throws NotFoundException when the ticket does not exist.
   */
  async unassignMe(
    actor: SupportActor,
    ticketId: string,
  ): Promise<TicketDetailDto> {
    this.assertSupportTeam(actor);
    await this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        select: { status: true },
        where: { id: ticketId },
      });
      if (!ticket) {
        throw new NotFoundException('Support ticket not found.');
      }
      if (ticket.status === TicketStatus.CLOSED) {
        throw new ConflictException(
          'Closed support tickets cannot be assigned.',
        );
      }
      await tx.ticketAssignee.deleteMany({
        where: { ticketId, userId: actor.userId },
      });
    });
    return this.getById(actor, ticketId);
  }

  /**
   * Marks the ticket and every response currently present as read by the actor.
   *
   * @param actor authenticated owner or Support Team reader.
   * @param ticketId target support ticket UUID.
   * @returns the single timestamp applied to ticket and response receipts.
   * @throws NotFoundException when the ticket does not exist.
   * @throws ForbiddenException when the actor cannot access the ticket.
   */
  async markRead(
    actor: SupportActor,
    ticketId: string,
  ): Promise<MarkReadResponseDto> {
    const readAt = await this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        select: {
          memberUserId: true,
          responses: { select: { id: true } },
        },
        where: { id: ticketId },
      });
      if (!ticket) {
        throw new NotFoundException('Support ticket not found.');
      }
      this.assertCanAccess(actor, ticket.memberUserId);

      const timestamp = new Date();
      await tx.ticketReadState.upsert({
        create: { lastReadAt: timestamp, ticketId, userId: actor.userId },
        update: { lastReadAt: timestamp },
        where: { ticketId_userId: { ticketId, userId: actor.userId } },
      });
      const responseIds = ticket.responses.map((response) => response.id);
      if (responseIds.length > 0) {
        await tx.responseReadReceipt.createMany({
          data: responseIds.map((responseId) => ({
            readAt: timestamp,
            responseId,
            userId: actor.userId,
          })),
          skipDuplicates: true,
        });
        await tx.responseReadReceipt.updateMany({
          data: { readAt: timestamp },
          where: {
            responseId: { in: responseIds },
            userId: actor.userId,
          },
        });
      }
      return timestamp;
    });
    return { readAt };
  }

  /**
   * Closes an open ticket as the authenticated Support Team member.
   *
   * A conditional update makes concurrent and repeated closes idempotent. Only
   * the transaction that changes OPEN to CLOSED queues close email and Slack
   * intents, preventing duplicate notifications.
   *
   * @param actor authenticated Support Team member resolving the ticket.
   * @param ticketId target support ticket UUID.
   * @returns updated full ticket detail.
   * @throws ForbiddenException when the actor lacks the Support Team role.
   * @throws NotFoundException when the ticket does not exist.
   */
  async close(actor: SupportActor, ticketId: string): Promise<TicketDetailDto> {
    this.assertSupportTeam(actor);
    const notificationIds = await this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        select: { status: true },
        where: { id: ticketId },
      });
      if (!ticket) {
        throw new NotFoundException('Support ticket not found.');
      }
      if (ticket.status === TicketStatus.CLOSED) {
        return [];
      }

      const closedAt = new Date();
      const closeUpdate = await tx.supportTicket.updateMany({
        data: {
          closedAt,
          closedByUserId: actor.userId,
          status: TicketStatus.CLOSED,
          updatedAt: closedAt,
        },
        where: { id: ticketId, status: TicketStatus.OPEN },
      });
      if (closeUpdate.count !== 1) {
        return [];
      }
      await tx.ticketReadState.upsert({
        create: { lastReadAt: closedAt, ticketId, userId: actor.userId },
        update: { lastReadAt: closedAt },
        where: { ticketId_userId: { ticketId, userId: actor.userId } },
      });
      return this.notificationOutbox.queueTicketClosed(tx, ticketId);
    });

    await this.dispatchAfterCommit(notificationIds);
    return this.getById(actor, ticketId);
  }

  /**
   * Rejects access unless the actor owns the ticket or belongs to Support Team.
   *
   * @param actor normalized authenticated actor.
   * @param memberUserId immutable ticket owner user ID.
   * @returns nothing when access is allowed.
   * @throws ForbiddenException when a normal member does not own the ticket.
   */
  private assertCanAccess(actor: SupportActor, memberUserId: string): void {
    if (!actor.isSupportTeam && actor.userId !== memberUserId) {
      throw new ForbiddenException('You cannot access this support ticket.');
    }
  }

  /**
   * Requires the normalized exact Support Team role decision.
   *
   * @param actor normalized authenticated actor.
   * @returns nothing when the actor belongs to Support Team.
   * @throws ForbiddenException when the actor is an ordinary member.
   */
  private assertSupportTeam(actor: SupportActor): void {
    if (!actor.isSupportTeam) {
      throw new ForbiddenException('Topcoder Support Team role is required.');
    }
  }

  /**
   * Attempts immediate delivery of committed notification intents.
   *
   * The durable outbox remains authoritative when immediate delivery fails, so
   * errors are deliberately swallowed after a metadata-only warning and the
   * already successful ticket mutation remains successful.
   *
   * @param notificationIds committed outbox intent IDs.
   * @returns a promise that resolves after delivery succeeds or is deferred.
   * @throws Does not throw; the scheduled outbox worker performs later retries.
   */
  private async dispatchAfterCommit(notificationIds: string[]): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }
    try {
      await this.notificationOutbox.dispatch(notificationIds);
    } catch {
      this.logger.warn(
        `Immediate notification dispatch deferred for ${notificationIds.length} outbox intent(s).`,
      );
    }
  }

  /**
   * Maps a database summary projection to the stable public list contract.
   *
   * @param record Prisma ticket summary projection.
   * @param actorUserId current actor used to derive unread state.
   * @returns public ticket summary with snapshot handles and assignments.
   * @throws Does not throw.
   */
  private toSummary(
    record: TicketSummaryRecord,
    actorUserId: string,
  ): TicketSummaryDto {
    const latestActivityAt = this.latestActivityAt(
      record.openedAt,
      record.closedAt,
      record.responses.map((response) => response.createdAt),
    );
    const actorReadState = record.readStates.find(
      (readState) => readState.userId === actorUserId,
    );
    return {
      assignees: record.assignees.map((assignee) => this.toAssignee(assignee)),
      challengeId: record.challengeId ?? undefined,
      closedAt: record.closedAt ?? undefined,
      description: record.description,
      hasUnread:
        !actorReadState || actorReadState.lastReadAt < latestActivityAt,
      id: record.id,
      latestActivityAt,
      memberHandle: record.memberHandle,
      memberHandleColor: record.memberHandleColor ?? undefined,
      memberUserId: record.memberUserId,
      openedAt: record.openedAt,
      responseCount: record._count.responses,
      status: record.status,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Maps a fully loaded ticket record to the public detail contract.
   *
   * @param record Prisma ticket detail projection.
   * @param actorUserId current actor used to derive unread state.
   * @returns public detail with ascending responses and receipt collections.
   * @throws Does not throw.
   */
  private toDetail(
    record: TicketDetailRecord,
    actorUserId: string,
  ): TicketDetailDto {
    const latestActivityAt = this.latestActivityAt(
      record.openedAt,
      record.closedAt,
      record.responses.map((response) => response.createdAt),
    );
    const actorReadState = record.readStates.find(
      (readState) => readState.userId === actorUserId,
    );
    const summary: TicketSummaryDto = {
      assignees: record.assignees.map((assignee) => this.toAssignee(assignee)),
      challengeId: record.challengeId ?? undefined,
      closedAt: record.closedAt ?? undefined,
      description: record.description,
      hasUnread:
        !actorReadState || actorReadState.lastReadAt < latestActivityAt,
      id: record.id,
      latestActivityAt,
      memberHandle: record.memberHandle,
      memberHandleColor: record.memberHandleColor ?? undefined,
      memberUserId: record.memberUserId,
      openedAt: record.openedAt,
      responseCount: record._count.responses,
      status: record.status,
      updatedAt: record.updatedAt,
    };
    return {
      ...summary,
      readBy: record.readStates.map((readState) => ({
        readAt: readState.lastReadAt,
        userId: readState.userId,
      })),
      responses: record.responses.map((response) => this.toMessage(response)),
    };
  }

  /**
   * Maps a persisted assignee snapshot to its public representation.
   *
   * @param assignee Prisma assignee row.
   * @returns public assignee snapshot.
   * @throws Does not throw.
   */
  private toAssignee(
    assignee: TicketSummaryRecord['assignees'][number],
  ): TicketAssigneeDto {
    return {
      assignedAt: assignee.assignedAt,
      handle: assignee.handle,
      handleColor: assignee.handleColor ?? undefined,
      userId: assignee.userId,
    };
  }

  /**
   * Maps a response and its receipts to the chronological public message shape.
   *
   * @param response Prisma response projection loaded for ticket detail.
   * @returns public response message with read receipts.
   * @throws Does not throw.
   */
  private toMessage(
    response: TicketDetailRecord['responses'][number],
  ): TicketMessageDto {
    const readBy: ReadReceiptDto[] = response.readReceipts.map((receipt) => ({
      readAt: receipt.readAt,
      userId: receipt.userId,
    }));
    return {
      createdAt: response.createdAt,
      id: response.id,
      markdown: response.markdown,
      readBy,
      userHandle: response.userHandle,
      userHandleColor: response.userHandleColor ?? undefined,
      userId: response.userId,
    };
  }

  /**
   * Calculates the newest content or close activity represented by a ticket.
   *
   * @param openedAt immutable ticket-open timestamp.
   * @param closedAt optional resolution timestamp.
   * @param responseDates response creation timestamps, in any order.
   * @returns the greatest supplied timestamp.
   * @throws Does not throw.
   */
  private latestActivityAt(
    openedAt: Date,
    closedAt: Date | null,
    responseDates: Date[],
  ): Date {
    return [openedAt, ...(closedAt ? [closedAt] : []), ...responseDates].reduce(
      (latest, candidate) => (candidate > latest ? candidate : latest),
      openedAt,
    );
  }
}
