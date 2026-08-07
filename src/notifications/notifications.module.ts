import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MemberDirectoryService } from './member-directory.service';
import { NotificationOutboxService } from './notification-outbox.service';

/** Provides the durable notification outbox and member-directory facade. */
@Module({
  imports: [DbModule, IntegrationsModule],
  providers: [MemberDirectoryService, NotificationOutboxService],
  exports: [MemberDirectoryService, NotificationOutboxService],
})
export class NotificationsModule {}
