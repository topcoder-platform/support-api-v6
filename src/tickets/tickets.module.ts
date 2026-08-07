import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

/** Registers ticket HTTP endpoints and application workflows. */
@Module({
  controllers: [TicketsController],
  exports: [TicketsService],
  imports: [AuthModule, NotificationsModule],
  providers: [TicketsService],
})
export class TicketsModule {}
