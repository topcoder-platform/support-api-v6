import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  BUS_API_CLIENT,
  EventBusService,
  buildBusApiClient,
} from './event-bus.service';
import { IdentityService } from './identity.service';
import { M2mService } from './m2m.service';
import { MemberApiService } from './member-api.service';
import { SlackService } from './slack.service';

const DEFAULT_OUTBOUND_HTTP_TIMEOUT_MS = 10_000;

/**
 * Reads a bounded timeout for calls to Identity, Member API, Auth0, and Slack.
 *
 * @param config application configuration.
 * @returns timeout in milliseconds, between one second and one minute.
 */
export function outboundHttpTimeout(config: ConfigService): number {
  const parsed = Number(config.get<string>('OUTBOUND_HTTP_TIMEOUT_MS'));
  return Number.isInteger(parsed) && parsed >= 1_000
    ? Math.min(parsed, 60_000)
    : DEFAULT_OUTBOUND_HTTP_TIMEOUT_MS;
}

/** Provides authenticated outbound integrations used by support notifications. */
@Module({
  imports: [
    ConfigModule,
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: outboundHttpTimeout(config),
      }),
    }),
  ],
  providers: [
    {
      provide: BUS_API_CLIENT,
      inject: [ConfigService],
      useFactory: buildBusApiClient,
    },
    EventBusService,
    IdentityService,
    M2mService,
    MemberApiService,
    SlackService,
  ],
  exports: [EventBusService, IdentityService, MemberApiService, SlackService],
})
export class IntegrationsModule {}
