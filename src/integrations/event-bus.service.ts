import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BusApiClient,
  BusApiConfiguration,
  BusApiEvent,
} from 'tc-bus-api-wrapper';
import createBusApiClient from 'tc-bus-api-wrapper';
import { auth } from 'tc-core-library-js';
import {
  integrationDeliveryError,
  providerDeliveryError,
} from './integration-delivery.error';

export const BUS_API_CLIENT = Symbol('BUS_API_CLIENT');

export type SupportEmailType = 'opened' | 'replied' | 'reopened' | 'closed';

interface SupportEmailPayload {
  recipients: string[];
  data: Record<string, unknown>;
  sendgrid_template_id: string;
  version: 'v3';
}

const TEMPLATE_KEYS: Record<SupportEmailType, string> = {
  opened: 'SENDGRID_SUPPORT_NEW_TICKET_TEMPLATE_ID',
  replied: 'SENDGRID_SUPPORT_REPLY_TEMPLATE_ID',
  reopened: 'SENDGRID_SUPPORT_REOPENED_TEMPLATE_ID',
  closed: 'SENDGRID_SUPPORT_CLOSED_TEMPLATE_ID',
};

const TEMPLATE_PLACEHOLDERS = new Set([
  'change_me',
  'replace_me',
  'tbd',
  'todo',
]);

/** Settings that fill the wrapper's `AUTH0_*` options when `USE_KEYCLOAK=true`. */
const KEYCLOAK_BUS_SETTINGS = {
  url: 'KEYCLOAK_TOKEN_URL',
  audience: 'KEYCLOAK_AUDIENCE',
  clientId: 'KEYCLOAK_CLIENT_ID',
  clientSecret: 'KEYCLOAK_CLIENT_SECRET',
  proxyUrl: 'KEYCLOAK_TOKEN_URL',
};

/** Pre-migration Auth0 settings used when `USE_KEYCLOAK` is unset or `false`. */
const AUTH0_BUS_SETTINGS = {
  url: 'AUTH0_URL',
  audience: 'AUTH0_AUDIENCE',
  clientId: 'AUTH0_CLIENT_ID',
  clientSecret: 'AUTH0_CLIENT_SECRET',
  proxyUrl: 'AUTH0_PROXY_SERVER_URL',
};

/**
 * Creates the shared Bus API client with a strictly v6 base URL.
 *
 * The wrapper's `AUTH0_*` option names carry the settings of the provider selected by
 * `USE_KEYCLOAK` (read through `auth.useKeycloak`): `KEYCLOAK_TOKEN_URL` (also the
 * proxy URL), `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET`
 * when `true`; `AUTH0_URL`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`,
 * `AUTH0_CLIENT_SECRET` and optional `AUTH0_PROXY_SERVER_URL` otherwise, as before
 * the migration. Used as the `BUS_API_CLIENT` provider factory.
 *
 * @param config application configuration containing Bus API and M2M values.
 * @returns an authenticated Topcoder Bus API wrapper client.
 * @throws Error when the active provider's settings are absent or BUSAPI_URL is not a
 * v6 base; TypeError when `USE_KEYCLOAK` is not `true`/`false`.
 */
export function buildBusApiClient(config: ConfigService): BusApiClient {
  const names = auth.useKeycloak() ? KEYCLOAK_BUS_SETTINGS : AUTH0_BUS_SETTINGS;
  const tokenCacheTime = Number(config.get<string>('TOKEN_CACHE_TIME'));
  const auth0ProxyServerUrl = config.get<string>(names.proxyUrl)?.trim();
  const options: BusApiConfiguration = {
    AUTH0_URL: required(config, names.url),
    AUTH0_AUDIENCE: required(config, names.audience),
    AUTH0_CLIENT_ID: required(config, names.clientId),
    AUTH0_CLIENT_SECRET: required(config, names.clientSecret),
    BUSAPI_URL: resolveV6BusApiBase(config),
    KAFKA_ERROR_TOPIC:
      config.get<string>('KAFKA_ERROR_TOPIC')?.trim() ||
      'common.error.reporting',
    ...(Number.isFinite(tokenCacheTime) && tokenCacheTime >= 0
      ? { TOKEN_CACHE_TIME: tokenCacheTime }
      : {}),
    ...(auth0ProxyServerUrl
      ? { AUTH0_PROXY_SERVER_URL: auth0ProxyServerUrl }
      : {}),
  };
  return createBusApiClient(options);
}

/**
 * Resolves and validates the wrapper base whose `/bus/events` suffix is added
 * by `tc-bus-api-wrapper`.
 *
 * @param config application configuration containing BUSAPI_URL.
 * @returns an absolute URL ending in `/v6`.
 * @throws Error when the URL is invalid or targets a non-v6 API.
 */
export function resolveV6BusApiBase(config: ConfigService): string {
  const configured =
    config.get<string>('BUSAPI_URL')?.trim() ||
    `${required(config, 'TOPCODER_API_URL_BASE').replace(/\/+$/, '')}/v6`;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('BUSAPI_URL must be an absolute URL ending in /v6.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/v6')) {
    throw new Error('BUSAPI_URL must be the v6 API base ending in /v6.');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Reads one required configuration string.
 *
 * @param config application configuration.
 * @param key configuration key.
 * @returns the trimmed value.
 * @throws Error when the value is absent.
 */
function required(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim();
  if (!value) {
    throw new Error(`Required integration configuration is missing: ${key}.`);
  }
  return value;
}

/**
 * Publishes support-ticket email requests to `external.action.email` using
 * the v3 SendGrid dynamic-template payload contract.
 */
@Injectable()
export class EventBusService {
  /**
   * Creates the email publisher.
   *
   * @param client authenticated shared Bus API client.
   * @param config application configuration containing template IDs.
   */
  constructor(
    @Inject(BUS_API_CLIENT) private readonly client: BusApiClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Publishes one support email using the template assigned to the event type.
   * Recipient addresses are normalized and deduplicated before publication.
   *
   * @param type support-ticket email type.
   * @param recipients destination email addresses.
   * @param data SendGrid dynamic-template data.
   * @returns a promise resolved after Bus API accepts the event.
   * @throws Error when the template or recipient list is missing or publishing fails.
   */
  async sendSupportEmail(
    type: SupportEmailType,
    recipients: string[],
    data: Record<string, unknown>,
  ): Promise<void> {
    const normalizedRecipients = Array.from(
      new Set(
        recipients
          .map((recipient) => recipient.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (normalizedRecipients.length === 0) {
      throw providerDeliveryError('email', 'no_eligible_recipients');
    }
    const templateId = this.config.get<string>(TEMPLATE_KEYS[type])?.trim();
    if (!templateId || TEMPLATE_PLACEHOLDERS.has(templateId.toLowerCase())) {
      throw providerDeliveryError('email', 'template_unconfigured');
    }

    const payload: SupportEmailPayload = {
      recipients: normalizedRecipients,
      data,
      sendgrid_template_id: templateId,
      version: 'v3',
    };
    const event: BusApiEvent<SupportEmailPayload> = {
      topic: 'external.action.email',
      originator: 'support-api-v6',
      timestamp: new Date().toISOString(),
      'mime-type': 'application/json',
      payload,
    };
    try {
      await this.client.postEvent(event);
    } catch (error) {
      throw integrationDeliveryError('bus_api', error);
    }
  }
}
