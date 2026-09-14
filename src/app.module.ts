import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuthMiddleware } from './auth/auth.middleware';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TicketsModule } from './tickets/tickets.module';

/** Root module wiring authentication, persistence, tickets, and notifications. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AttachmentsModule,
    AuthModule,
    DbModule,
    NotificationsModule,
    TicketsModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Applies optional JWT validation before route-level authentication guards.
   *
   * @param consumer Nest middleware registry.
   * @returns void.
   * @throws Does not throw directly.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
