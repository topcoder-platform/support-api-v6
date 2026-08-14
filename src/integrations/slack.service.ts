import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  integrationDeliveryError,
  providerDeliveryError,
} from './integration-delivery.error';

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
}

/** Publishes support-ticket lifecycle messages to the configured Slack channel. */
@Injectable()
export class SlackService {
  private readonly endpoint = 'https://slack.com/api/chat.postMessage';

  /**
   * Creates the Slack integration.
   *
   * @param http HTTP client used for Slack Web API calls.
   * @param config application configuration containing bot/channel settings.
   */
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Posts one plain support notification and validates Slack's JSON success
   * flag, which can indicate failure even on HTTP 200.
   *
   * @param message safe multi-line notification text; raw ticket markdown must
   *   not be supplied, only sanitized and bounded previews of it.
   * @returns a promise resolved after Slack accepts the message.
   * @throws Error when configuration is missing or Slack returns `ok: false`.
   */
  async sendNotification(message: string): Promise<void> {
    const botKey = this.config.get<string>('SLACK_BOT_KEY')?.trim();
    const channel = this.config.get<string>('SLACK_CHANNEL_ID')?.trim();
    if (!botKey || !channel) {
      throw providerDeliveryError('slack', 'not_configured');
    }

    let response;
    try {
      response = await firstValueFrom(
        this.http.post<SlackApiResponse>(
          this.endpoint,
          { channel, text: this.withEnvironmentPrefix(message) },
          {
            headers: {
              Authorization: `Bearer ${botKey}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
      );
    } catch (error) {
      throw integrationDeliveryError('slack', error);
    }
    if (response.data?.ok !== true) {
      throw providerDeliveryError('slack', response.data?.error);
    }
  }

  /**
   * Adds a non-production environment marker to avoid confusing test events
   * with production support activity.
   *
   * @param message support notification text.
   * @returns message with an environment prefix outside production.
   */
  private withEnvironmentPrefix(message: string): string {
    const configuredEnvironment =
      this.config.get<string>('ENV_NAME')?.trim() ||
      this.config.get<string>('NODE_ENV')?.trim() ||
      'DEV';
    const normalized = configuredEnvironment.toLowerCase();
    if (normalized === 'prod' || normalized === 'production') {
      return message;
    }
    return `[${configuredEnvironment}] ${message}`;
  }
}
