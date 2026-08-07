import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { IntegrationDeliveryError } from './integration-delivery.error';
import { SlackService } from './slack.service';

/** Creates a ConfigService test double backed by plain values. */
function configWith(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('SlackService', () => {
  it('posts to the configured channel and validates Slack ok', async () => {
    const post = jest.fn().mockReturnValue(of({ data: { ok: true } }));
    const http = {
      post,
    } as unknown as HttpService;
    const service = new SlackService(
      http,
      configWith({
        ENV_NAME: 'DEV',
        SLACK_BOT_KEY: 'bot-secret',
        SLACK_CHANNEL_ID: 'channel-1',
      }),
    );

    await service.sendNotification('New ticket https://support/tickets/1');

    expect(post).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      {
        channel: 'channel-1',
        text: '[DEV] New ticket https://support/tickets/1',
      },
      {
        headers: {
          Authorization: 'Bearer bot-secret',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
  });

  it('rejects an HTTP 200 response whose Slack body is not ok', async () => {
    const http = {
      post: jest
        .fn()
        .mockReturnValue(
          of({ data: { error: 'channel_not_found', ok: false } }),
        ),
    } as unknown as HttpService;
    const service = new SlackService(
      http,
      configWith({
        ENV_NAME: 'production',
        SLACK_BOT_KEY: 'bot-secret',
        SLACK_CHANNEL_ID: 'missing-channel',
      }),
    );

    await expect(service.sendNotification('New ticket')).rejects.toMatchObject({
      name: IntegrationDeliveryError.name,
      safeCode: 'slack_channel_not_found',
    });
  });
});
