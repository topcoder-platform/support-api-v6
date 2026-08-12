import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { DbService } from '../db/db.service';
import { EventBusService } from '../integrations/event-bus.service';
import {
  IntegrationDeliveryError,
  safeIntegrationFailureCode,
} from '../integrations/integration-delivery.error';
import { SlackService } from '../integrations/slack.service';
import { MemberDirectoryService } from './member-directory.service';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60_000;
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const NOTIFICATION_PREVIEW_CHARACTERS = 320;

/**
 * Converts user-authored markdown to a compact plain-text notification preview.
 * URLs, formatting markers, HTML tags, and excess whitespace are removed before
 * the result is bounded without splitting a Unicode code point.
 *
 * @param markdown untrusted ticket or response markdown.
 * @param maximumCharacters maximum Unicode code points in the returned preview.
 * @returns normalized plain text with an ellipsis when truncation is required.
 */
export function markdownNotificationPreview(
  markdown: string,
  maximumCharacters = NOTIFICATION_PREVIEW_CHARACTERS,
): string {
  const boundedMaximum =
    Number.isInteger(maximumCharacters) && maximumCharacters > 0
      ? maximumCharacters
      : NOTIFICATION_PREVIEW_CHARACTERS;
  const plainText = String(markdown)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[~*_]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const codePoints = Array.from(plainText);
  if (codePoints.length <= boundedMaximum) {
    return plainText;
  }
  if (boundedMaximum === 1) {
    return '…';
  }
  return `${codePoints
    .slice(0, boundedMaximum - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * Reads the polling interval before Nest registers the interval metadata.
 * Runtime ECS variables are present before module loading; invalid values use
 * the stable default.
 *
 * @returns a positive polling interval in milliseconds.
 */
function notificationPollInterval(): number {
  const parsed = Number(process.env['NOTIFICATION_POLL_INTERVAL_MS']);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_POLL_INTERVAL_MS;
}

interface NotificationIntent {
  dedupeKey: string;
  ticketId: string;
  responseId?: string;
  channel: NotificationChannel;
  type: NotificationType;
}

interface ClaimedNotification {
  id: string;
  lockedAt: Date;
}

type NotificationRecord = Prisma.NotificationOutboxGetPayload<{
  include: { response: true; ticket: true };
}>;

/**
 * Owns durable support notification intents, atomic multi-instance claims,
 * bounded retry scheduling, and channel-specific delivery.
 */
@Injectable()
export class NotificationOutboxService {
  private readonly logger = new Logger(NotificationOutboxService.name);
  private polling = false;

  /**
   * Creates the notification outbox processor.
   *
   * @param db shared Prisma database client.
   * @param config application configuration for retry and link behavior.
   * @param eventBus external email publisher.
   * @param slack Slack channel publisher.
   * @param members member and support-team directory.
   */
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly slack: SlackService,
    private readonly members: MemberDirectoryService,
  ) {}

  /**
   * Queues support-team email and Slack intents for a newly opened ticket.
   * Duplicate calls return the existing intent IDs.
   *
   * @param tx transaction that created the ticket.
   * @param ticketId persisted ticket ID.
   * @returns queued or existing outbox IDs.
   * @throws Prisma errors so the caller's domain transaction rolls back atomically.
   */
  async queueTicketOpened(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<string[]> {
    return this.queueIntents(tx, [
      {
        dedupeKey: `ticket:${ticketId}:opened:email`,
        ticketId,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.TICKET_OPENED,
      },
      {
        dedupeKey: `ticket:${ticketId}:opened:slack`,
        ticketId,
        channel: NotificationChannel.SLACK,
        type: NotificationType.TICKET_OPENED,
      },
    ]);
  }

  /**
   * Queues a member email only when a support-team user authored the reply.
   * Member-authored replies deliberately create no notification intent.
   *
   * @param tx transaction that created the response.
   * @param ticketId parent ticket ID.
   * @param responseId persisted response ID.
   * @returns the queued/existing email intent ID, or an empty list for a member reply.
   * @throws Prisma errors or Error when the newly-created response cannot be loaded.
   */
  async queueTicketReplied(
    tx: Prisma.TransactionClient,
    ticketId: string,
    responseId: string,
  ): Promise<string[]> {
    const response = await tx.supportResponse.findUnique({
      where: { id: responseId },
      select: {
        ticketId: true,
        userId: true,
        ticket: { select: { memberUserId: true } },
      },
    });
    if (!response || response.ticketId !== ticketId) {
      throw new Error('New support response could not be queued for delivery.');
    }
    if (response.userId === response.ticket.memberUserId) {
      return [];
    }
    return this.queueIntents(tx, [
      {
        dedupeKey: `ticket:${ticketId}:response:${responseId}:replied:email`,
        ticketId,
        responseId,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.TICKET_REPLIED,
      },
    ]);
  }

  /**
   * Queues support-team email and Slack intents when the ticket owner reopens a
   * closed ticket by replying. The response ID makes each reopen transition
   * retry-idempotent while permitting later close/reopen cycles.
   *
   * @param tx transaction that reopened the ticket and created the response.
   * @param ticketId reopened ticket ID.
   * @param responseId member response that triggered the transition.
   * @returns queued or existing outbox IDs.
   * @throws Prisma errors or Error when the response is not an owner response for the ticket.
   */
  async queueTicketReopened(
    tx: Prisma.TransactionClient,
    ticketId: string,
    responseId: string,
  ): Promise<string[]> {
    const response = await tx.supportResponse.findUnique({
      where: { id: responseId },
      select: {
        ticketId: true,
        userId: true,
        ticket: { select: { memberUserId: true } },
      },
    });
    if (
      !response ||
      response.ticketId !== ticketId ||
      response.userId !== response.ticket.memberUserId
    ) {
      throw new Error('Ticket reopen does not have a member-owner response.');
    }
    return this.queueIntents(tx, [
      {
        dedupeKey: `ticket:${ticketId}:response:${responseId}:reopened:email`,
        ticketId,
        responseId,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.TICKET_REOPENED,
      },
      {
        dedupeKey: `ticket:${ticketId}:response:${responseId}:reopened:slack`,
        ticketId,
        responseId,
        channel: NotificationChannel.SLACK,
        type: NotificationType.TICKET_REOPENED,
      },
    ]);
  }

  /**
   * Queues member email and Slack intents for a closed ticket.
   * A collision-proof ID generated by the winning close transition distinguishes
   * later close cycles while remaining shared by that cycle's email and Slack rows.
   *
   * @param tx transaction that closed the ticket.
   * @param ticketId persisted ticket ID.
   * @param closeEventId unique discriminator generated by the winning close transition.
   * @returns queued or existing outbox IDs.
   * @throws Prisma errors so the caller's domain transaction rolls back atomically.
   */
  async queueTicketClosed(
    tx: Prisma.TransactionClient,
    ticketId: string,
    closeEventId: string,
  ): Promise<string[]> {
    return this.queueIntents(tx, [
      {
        dedupeKey: `ticket:${ticketId}:closed:${closeEventId}:email`,
        ticketId,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.TICKET_CLOSED,
      },
      {
        dedupeKey: `ticket:${ticketId}:closed:${closeEventId}:slack`,
        ticketId,
        channel: NotificationChannel.SLACK,
        type: NotificationType.TICKET_CLOSED,
      },
    ]);
  }

  /**
   * Immediately attempts eligible IDs after their surrounding transaction has
   * committed. All failures are contained so callers may safely fire-and-forget.
   *
   * @param ids outbox IDs returned by a queue method.
   * @returns a promise resolved after the bounded dispatch attempt settles.
   */
  async dispatch(ids: string[]): Promise<void> {
    const normalizedIds = Array.from(
      new Set(ids.map((id) => String(id).trim()).filter(Boolean)),
    );
    if (normalizedIds.length === 0) {
      return;
    }
    try {
      await this.recoverUnavailableWork();
      await this.claimAndDeliver(normalizedIds);
    } catch {
      this.logger.error('Immediate support notification dispatch failed.');
    }
  }

  /**
   * Polls due outbox rows. A process-local guard prevents overlapping intervals,
   * while row-level skip-locked claims coordinate separate ECS tasks.
   *
   * @returns a promise resolved after one batch settles.
   */
  @Interval('support-notification-outbox', notificationPollInterval())
  async processPendingNotifications(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.recoverUnavailableWork();
      await this.claimAndDeliver();
    } catch {
      this.logger.error('Scheduled support notification dispatch failed.');
    } finally {
      this.polling = false;
    }
  }

  /**
   * Persists unique intents inside the caller's transaction and resolves their
   * IDs, including rows inserted by an earlier duplicate call.
   *
   * @param tx caller-owned Prisma transaction.
   * @param intents channel-specific notification intents.
   * @returns queued or existing outbox IDs.
   * @throws Prisma errors so notification intent and domain mutation stay atomic.
   */
  private async queueIntents(
    tx: Prisma.TransactionClient,
    intents: NotificationIntent[],
  ): Promise<string[]> {
    await tx.notificationOutbox.createMany({
      data: intents,
      skipDuplicates: true,
    });
    const records = await tx.notificationOutbox.findMany({
      where: { dedupeKey: { in: intents.map((intent) => intent.dedupeKey) } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return records.map((record) => record.id);
  }

  /**
   * Atomically claims one due batch and delivers every claimed row independently.
   *
   * @param requestedIds optional allowlist used by immediate dispatch.
   * @returns a promise resolved when all claimed rows settle.
   */
  private async claimAndDeliver(requestedIds?: string[]): Promise<void> {
    const claims = await this.claimNotifications(requestedIds);
    const results = await Promise.allSettled(
      claims.map((claim) => this.deliverClaim(claim)),
    );
    if (results.some((result) => result.status === 'rejected')) {
      this.logger.error('One or more claimed notifications could not settle.');
    }
  }

  /**
   * Uses one PostgreSQL statement with `FOR UPDATE SKIP LOCKED` to prevent two
   * service instances from owning the same outbox row.
   *
   * @param requestedIds optional allowlist of outbox IDs.
   * @returns rows claimed by this statement with their lease timestamps.
   * @throws Prisma database errors.
   */
  private async claimNotifications(
    requestedIds?: string[],
  ): Promise<ClaimedNotification[]> {
    const now = new Date();
    const maxAttempts = this.maxAttempts();
    const batchSize = this.batchSize();
    const idFilter = requestedIds
      ? Prisma.sql`AND "id" IN (${Prisma.join(requestedIds)})`
      : Prisma.empty;

    return this.db.$queryRaw<ClaimedNotification[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "support"."notification_outbox"
        WHERE "status" IN (
          'PENDING'::"support"."NotificationStatus",
          'FAILED'::"support"."NotificationStatus"
        )
          AND "nextAttemptAt" <= ${now}
          AND "attempts" < ${maxAttempts}
          ${idFilter}
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE "support"."notification_outbox" AS outbox
      SET
        "status" = 'PROCESSING'::"support"."NotificationStatus",
        "attempts" = outbox."attempts" + 1,
        "lockedAt" = ${now},
        "updatedAt" = ${now}
      FROM candidates
      WHERE outbox."id" = candidates."id"
      RETURNING outbox."id", outbox."lockedAt"
    `);
  }

  /**
   * Loads and delivers one claimed row, then records SENT, FAILED, or DEAD.
   * Every state transition checks the lease timestamp to avoid a stale worker
   * overwriting a newer claim.
   *
   * @param claim claimed outbox row and lease timestamp.
   * @returns a promise resolved after a terminal state update for this attempt.
   */
  private async deliverClaim(claim: ClaimedNotification): Promise<void> {
    const record = await this.db.notificationOutbox.findUnique({
      where: { id: claim.id },
      include: { response: true, ticket: true },
    });
    if (!this.ownsClaim(record, claim)) {
      return;
    }

    try {
      if (record.channel === NotificationChannel.EMAIL) {
        await this.deliverEmail(record);
      } else if (record.channel === NotificationChannel.SLACK) {
        await this.deliverSlack(record);
      } else {
        throw new IntegrationDeliveryError('unsupported_channel');
      }
      const settled = await this.db.notificationOutbox.updateMany({
        where: {
          id: record.id,
          status: NotificationStatus.PROCESSING,
          lockedAt: claim.lockedAt,
        },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
      if (settled.count === 1) {
        this.logger.log(
          `Support notification ${record.id} channel=${record.channel} ` +
            `type=${record.type} status=${NotificationStatus.SENT}.`,
        );
      }
    } catch (error) {
      await this.recordDeliveryFailure(record, claim.lockedAt, error);
    }
  }

  /**
   * Publishes the event-type-specific email to its mandated recipients.
   *
   * @param record claimed outbox row with ticket and optional response.
   * @returns a promise resolved after Bus API accepts the email event.
   * @throws directory, configuration, or Bus API errors.
   */
  private async deliverEmail(record: NotificationRecord): Promise<void> {
    const ticketUrl = this.ticketUrl(record.ticketId);
    if (record.type === NotificationType.TICKET_OPENED) {
      const recipients = (await this.members.listSupportTeamMembers()).map(
        (member) => member.email,
      );
      await this.eventBus.sendSupportEmail('opened', recipients, {
        ticketId: record.ticketId,
        ticketUrl,
        memberHandle: record.ticket.memberHandle,
        challengeId: record.ticket.challengeId ?? '',
        descriptionPreview: markdownNotificationPreview(
          record.ticket.description,
        ),
        openedAt: record.ticket.openedAt.toISOString(),
      });
      return;
    }

    if (record.type === NotificationType.TICKET_REOPENED) {
      if (
        !record.response ||
        record.response.userId !== record.ticket.memberUserId
      ) {
        throw new IntegrationDeliveryError('reopened_response_invalid');
      }
      const recipients = (await this.members.listSupportTeamMembers()).map(
        (member) => member.email,
      );
      await this.eventBus.sendSupportEmail('reopened', recipients, {
        ticketId: record.ticketId,
        ticketUrl,
        memberHandle: record.ticket.memberHandle,
        challengeId: record.ticket.challengeId ?? '',
        responsePreview: markdownNotificationPreview(record.response.markdown),
        reopenedAt: record.response.createdAt.toISOString(),
      });
      return;
    }

    const member = await this.members.getUserSnapshot(
      record.ticket.memberUserId,
      record.ticket.memberHandle,
    );
    if (!member.email) {
      throw new IntegrationDeliveryError('member_email_missing');
    }
    if (record.type === NotificationType.TICKET_REPLIED) {
      if (
        !record.response ||
        record.response.userId === record.ticket.memberUserId
      ) {
        throw new IntegrationDeliveryError('reply_response_invalid');
      }
      await this.eventBus.sendSupportEmail('replied', [member.email], {
        ticketId: record.ticketId,
        ticketUrl,
        memberHandle: record.ticket.memberHandle,
        challengeId: record.ticket.challengeId ?? '',
        responderHandle: record.response.userHandle,
        responsePreview: markdownNotificationPreview(record.response.markdown),
        repliedAt: record.response.createdAt.toISOString(),
      });
      return;
    }
    if (record.type === NotificationType.TICKET_CLOSED) {
      await this.eventBus.sendSupportEmail('closed', [member.email], {
        ticketId: record.ticketId,
        ticketUrl,
        memberHandle: record.ticket.memberHandle,
        challengeId: record.ticket.challengeId ?? '',
        descriptionPreview: markdownNotificationPreview(
          record.ticket.description,
        ),
        closedAt: record.createdAt.toISOString(),
      });
      return;
    }
    throw new IntegrationDeliveryError('unsupported_email_type');
  }

  /**
   * Publishes safe lifecycle text to Slack without including ticket markdown.
   *
   * @param record claimed outbox row with ticket data.
   * @returns a promise resolved after Slack accepts the message.
   * @throws Slack or unsupported-event errors.
   */
  private async deliverSlack(record: NotificationRecord): Promise<void> {
    const handle = this.escapeSlack(record.ticket.memberHandle);
    const link = this.ticketUrl(record.ticketId);
    if (record.type === NotificationType.TICKET_OPENED) {
      const challenge = record.ticket.challengeId
        ? ` Challenge: ${this.escapeSlack(record.ticket.challengeId)}.`
        : '';
      await this.slack.sendNotification(
        `New support ticket opened by ${handle}.${challenge} ${link}`,
      );
      return;
    }
    if (record.type === NotificationType.TICKET_CLOSED) {
      await this.slack.sendNotification(
        `Support ticket for ${handle} was closed. ${link}`,
      );
      return;
    }
    if (record.type === NotificationType.TICKET_REOPENED) {
      await this.slack.sendNotification(
        `Support ticket was reopened by ${handle}. ${link}`,
      );
      return;
    }
    throw new IntegrationDeliveryError('unsupported_slack_type');
  }

  /**
   * Records an isolated failed attempt with exponential backoff or DEAD after
   * the configured attempt limit.
   *
   * @param record failed claimed record.
   * @param lockedAt lease timestamp held by this worker.
   * @param error unknown delivery failure; only a sanitized code is retained.
   * @returns a promise resolved after the conditional state update.
   */
  private async recordDeliveryFailure(
    record: NotificationRecord,
    lockedAt: Date,
    error: unknown,
  ): Promise<void> {
    const exhausted = record.attempts >= this.maxAttempts();
    const failureCode = safeIntegrationFailureCode(error);
    const nextStatus = exhausted
      ? NotificationStatus.DEAD
      : NotificationStatus.FAILED;
    await this.db.notificationOutbox.updateMany({
      where: {
        id: record.id,
        status: NotificationStatus.PROCESSING,
        lockedAt,
      },
      data: {
        status: nextStatus,
        nextAttemptAt: exhausted
          ? record.nextAttemptAt
          : new Date(Date.now() + this.retryDelay(record.attempts)),
        lockedAt: null,
        lastError:
          `${record.channel}/${record.type} delivery failed ` +
          `(${failureCode}); ${
            exhausted ? 'retry limit exhausted' : 'retry scheduled'
          }.`,
      },
    });
    this.logger.warn(
      `Support notification ${record.id} channel=${record.channel} ` +
        `type=${record.type} attempt=${record.attempts}/${this.maxAttempts()} ` +
        `failure=${failureCode} status=${nextStatus}.`,
    );
  }

  /**
   * Recovers expired processing leases and retires any already-exhausted rows.
   *
   * @returns a promise resolved after recovery state transitions.
   * @throws Prisma database errors.
   */
  private async recoverUnavailableWork(): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - this.processingTimeoutMilliseconds(),
    );
    const staleLease = {
      status: NotificationStatus.PROCESSING,
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    } satisfies Prisma.NotificationOutboxWhereInput;

    await this.db.notificationOutbox.updateMany({
      where: { ...staleLease, attempts: { gte: this.maxAttempts() } },
      data: {
        status: NotificationStatus.DEAD,
        lockedAt: null,
        lastError: 'Processing lease expired after the retry limit.',
      },
    });
    await this.db.notificationOutbox.updateMany({
      where: { ...staleLease, attempts: { lt: this.maxAttempts() } },
      data: {
        status: NotificationStatus.FAILED,
        nextAttemptAt: new Date(now.getTime() + BASE_RETRY_DELAY_MS),
        lockedAt: null,
        lastError: 'Processing lease expired and will be retried.',
      },
    });
    await this.db.notificationOutbox.updateMany({
      where: {
        status: {
          in: [NotificationStatus.PENDING, NotificationStatus.FAILED],
        },
        attempts: { gte: this.maxAttempts() },
      },
      data: {
        status: NotificationStatus.DEAD,
        lockedAt: null,
        lastError: 'Notification reached its retry limit.',
      },
    });
  }

  /**
   * Verifies that a fetched row is still owned by the supplied lease.
   *
   * @param record fetched outbox record.
   * @param claim expected claim ID and timestamp.
   * @returns true only while this worker still owns the PROCESSING row.
   */
  private ownsClaim(
    record: NotificationRecord | null,
    claim: ClaimedNotification,
  ): record is NotificationRecord {
    return Boolean(
      record &&
      record.status === NotificationStatus.PROCESSING &&
      record.lockedAt?.getTime() === claim.lockedAt.getTime(),
    );
  }

  /**
   * Builds the environment-specific public support ticket link.
   *
   * @param ticketId ticket UUID.
   * @returns absolute support UI ticket URL.
   */
  private ticketUrl(ticketId: string): string {
    const base =
      this.config.get<string>('SUPPORT_APP_BASE_URL')?.trim() ||
      'https://support.topcoder-dev.com';
    return `${base.replace(/\/+$/, '')}/tickets/${encodeURIComponent(ticketId)}`;
  }

  /**
   * Escapes Slack control characters in user-controlled short text.
   *
   * @param value handle or challenge identifier.
   * @returns safely escaped Slack text.
   */
  private escapeSlack(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Computes exponential retry delay capped at one hour.
   *
   * @param attempts number of claims already attempted.
   * @returns retry delay in milliseconds.
   */
  private retryDelay(attempts: number): number {
    return Math.min(
      MAX_RETRY_DELAY_MS,
      BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
    );
  }

  /**
   * Reads the configured claim batch size.
   *
   * @returns a positive batch size capped at 100.
   */
  private batchSize(): number {
    return this.positiveInteger(
      this.config.get<string>('NOTIFICATION_BATCH_SIZE'),
      DEFAULT_BATCH_SIZE,
      100,
    );
  }

  /**
   * Reads the configured maximum delivery attempt count.
   *
   * @returns a positive attempt limit capped at 100.
   */
  private maxAttempts(): number {
    return this.positiveInteger(
      this.config.get<string>('NOTIFICATION_MAX_ATTEMPTS'),
      DEFAULT_MAX_ATTEMPTS,
      100,
    );
  }

  /**
   * Reads the configured processing lease timeout.
   *
   * @returns timeout in milliseconds, with a minimum of one second.
   */
  private processingTimeoutMilliseconds(): number {
    return this.positiveInteger(
      this.config.get<string>('NOTIFICATION_PROCESSING_TIMEOUT_MS'),
      DEFAULT_PROCESSING_TIMEOUT_MS,
      24 * 60 * 60_000,
    );
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
}
