CREATE SCHEMA IF NOT EXISTS "support";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "support"."TicketStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "support"."NotificationChannel" AS ENUM ('EMAIL', 'SLACK');
CREATE TYPE "support"."NotificationType" AS ENUM ('TICKET_OPENED', 'TICKET_REPLIED', 'TICKET_CLOSED');
CREATE TYPE "support"."NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD');

CREATE TABLE "support"."support_tickets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "memberUserId" VARCHAR(64) NOT NULL,
  "memberHandle" VARCHAR(100) NOT NULL,
  "memberHandleColor" VARCHAR(32),
  "challengeId" VARCHAR(64),
  "description" TEXT NOT NULL,
  "status" "support"."TicketStatus" NOT NULL DEFAULT 'OPEN',
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closedByUserId" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support"."support_responses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ticketId" UUID NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "userHandle" VARCHAR(100) NOT NULL,
  "userHandleColor" VARCHAR(32),
  "markdown" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_responses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support"."ticket_assignees" (
  "ticketId" UUID NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "handle" VARCHAR(100) NOT NULL,
  "handleColor" VARCHAR(32),
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedByUserId" VARCHAR(64) NOT NULL,
  CONSTRAINT "ticket_assignees_pkey" PRIMARY KEY ("ticketId", "userId")
);

CREATE TABLE "support"."ticket_read_states" (
  "ticketId" UUID NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_read_states_pkey" PRIMARY KEY ("ticketId", "userId")
);

CREATE TABLE "support"."response_read_receipts" (
  "responseId" UUID NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "response_read_receipts_pkey" PRIMARY KEY ("responseId", "userId")
);

CREATE TABLE "support"."notification_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "dedupeKey" VARCHAR(180) NOT NULL,
  "ticketId" UUID NOT NULL,
  "responseId" UUID,
  "channel" "support"."NotificationChannel" NOT NULL,
  "type" "support"."NotificationType" NOT NULL,
  "status" "support"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "lastError" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_outbox_dedupeKey_key" ON "support"."notification_outbox"("dedupeKey");
CREATE INDEX "support_tickets_status_openedAt_idx" ON "support"."support_tickets"("status", "openedAt");
CREATE INDEX "support_tickets_memberUserId_status_openedAt_idx" ON "support"."support_tickets"("memberUserId", "status", "openedAt");
CREATE INDEX "support_tickets_challengeId_idx" ON "support"."support_tickets"("challengeId");
CREATE INDEX "support_responses_ticketId_createdAt_id_idx" ON "support"."support_responses"("ticketId", "createdAt", "id");
CREATE INDEX "ticket_assignees_userId_idx" ON "support"."ticket_assignees"("userId");
CREATE INDEX "ticket_read_states_userId_idx" ON "support"."ticket_read_states"("userId");
CREATE INDEX "response_read_receipts_userId_idx" ON "support"."response_read_receipts"("userId");
CREATE INDEX "notification_outbox_status_nextAttemptAt_idx" ON "support"."notification_outbox"("status", "nextAttemptAt");
CREATE INDEX "notification_outbox_ticketId_type_idx" ON "support"."notification_outbox"("ticketId", "type");

ALTER TABLE "support"."support_responses" ADD CONSTRAINT "support_responses_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support"."ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support"."ticket_read_states" ADD CONSTRAINT "ticket_read_states_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support"."response_read_receipts" ADD CONSTRAINT "response_read_receipts_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "support"."support_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support"."notification_outbox" ADD CONSTRAINT "notification_outbox_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support"."notification_outbox" ADD CONSTRAINT "notification_outbox_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "support"."support_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
