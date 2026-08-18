ALTER TYPE "support"."NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_ASSIGNED';

ALTER TABLE "support"."notification_outbox"
  ADD COLUMN IF NOT EXISTS "assigneeHandle" VARCHAR(100);
