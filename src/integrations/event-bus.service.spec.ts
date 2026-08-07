import { ConfigService } from '@nestjs/config';
import type { BusApiClient, BusApiEvent } from 'tc-bus-api-wrapper';
import { EventBusService, resolveV6BusApiBase } from './event-bus.service';
import { IntegrationDeliveryError } from './integration-delivery.error';

/** Creates a ConfigService test double backed by plain values. */
function configWith(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('EventBusService', () => {
  it.each([
    ['opened', 'opened-template'],
    ['replied', 'reply-template'],
    ['reopened', 'reopened-template'],
    ['closed', 'closed-template'],
  ] as const)(
    'publishes a complete external.action.email envelope for %s',
    async (type, expectedTemplate) => {
      const postEvent = jest.fn().mockResolvedValue(undefined);
      const client = {
        postEvent,
      } as unknown as BusApiClient;
      const service = new EventBusService(
        client,
        configWith({
          SENDGRID_SUPPORT_CLOSED_TEMPLATE_ID: 'closed-template',
          SENDGRID_SUPPORT_NEW_TICKET_TEMPLATE_ID: 'opened-template',
          SENDGRID_SUPPORT_REPLY_TEMPLATE_ID: 'reply-template',
          SENDGRID_SUPPORT_REOPENED_TEMPLATE_ID: 'reopened-template',
        }),
      );

      await service.sendSupportEmail(
        type,
        [' STAFF@EXAMPLE.COM ', 'staff@example.com', 'other@example.com'],
        { ticketId: 'ticket-1', ticketUrl: 'https://support/tickets/ticket-1' },
      );

      expect(postEvent).toHaveBeenCalledTimes(1);
      const event = postEvent.mock.calls[0][0] as BusApiEvent<
        Record<string, unknown>
      >;
      expect(event).toMatchObject({
        'mime-type': 'application/json',
        originator: 'support-api-v6',
        payload: {
          data: {
            ticketId: 'ticket-1',
            ticketUrl: 'https://support/tickets/ticket-1',
          },
          recipients: ['staff@example.com', 'other@example.com'],
          sendgrid_template_id: expectedTemplate,
          version: 'v3',
        },
        topic: 'external.action.email',
      });
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    },
  );

  it('rejects a known placeholder template without publishing', async () => {
    const postEvent = jest.fn();
    const service = new EventBusService(
      { postEvent },
      configWith({ SENDGRID_SUPPORT_REOPENED_TEMPLATE_ID: 'REPLACE_ME' }),
    );

    await expect(
      service.sendSupportEmail('reopened', ['support@example.com'], {
        ticketId: 'ticket-1',
      }),
    ).rejects.toMatchObject({ safeCode: 'email_template_unconfigured' });
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('retains only a safe Bus API status when publication fails', async () => {
    const remoteError = Object.assign(
      new Error('Bearer secret and recipient@example.com'),
      { status: 403 },
    );
    const service = new EventBusService(
      {
        postEvent: jest.fn().mockRejectedValue(remoteError),
      },
      configWith({ SENDGRID_SUPPORT_REPLY_TEMPLATE_ID: 'reply-template' }),
    );

    await expect(
      service.sendSupportEmail('replied', ['member@example.com'], {
        ticketId: 'ticket-1',
      }),
    ).rejects.toMatchObject({
      name: IntegrationDeliveryError.name,
      safeCode: 'bus_api_http_403',
    });
  });

  it('requires the wrapper base to end at API v6', () => {
    expect(
      resolveV6BusApiBase(
        configWith({ BUSAPI_URL: 'https://api.topcoder.com/v6/' }),
      ),
    ).toBe('https://api.topcoder.com/v6');
    expect(() =>
      resolveV6BusApiBase(
        configWith({ BUSAPI_URL: 'https://api.topcoder.com/v5' }),
      ),
    ).toThrow('v6 API base');
  });
});
