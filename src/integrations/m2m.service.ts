import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auth } from 'tc-core-library-js';

/**
 * Provides M2M tokens for outbound service calls (Identity and Member API) from the
 * provider selected by `USE_KEYCLOAK`, using the shared core cache.
 *
 * With `USE_KEYCLOAK=true` the core uses `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`,
 * `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` and optional `KEYCLOAK_SCOPE`, and
 * ignores the Auth0 options. Unset or `false` uses the pre-migration Auth0 settings
 * from {@link M2mService.auth0Options}.
 */
@Injectable()
export class M2mService {
  private readonly client: ReturnType<typeof auth.m2m>;

  /**
   * Creates the token provider for the active M2M provider.
   * @param config application configuration containing the Auth0 settings.
   * @throws TypeError for invalid Keycloak settings or a `USE_KEYCLOAK` value other than `true`/`false`.
   */
  constructor(config: ConfigService) {
    this.client = auth.m2m(M2mService.auth0Options(config));
  }

  /**
   * Maps the pre-migration Auth0 settings to the core's Auth0 option names, trimmed
   * as before: `AUTH0_URL`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`
   * and optional `AUTH0_PROXY_SERVER_URL` (the request goes to the proxy when it is
   * set and to `AUTH0_URL` otherwise, with `auth0_url` in the body). The core uses
   * them only when `USE_KEYCLOAK` is not true.
   * @param config application configuration to read.
   * @returns Options for `auth.m2m`; empty values become undefined so a token request
   * rejects instead of the service failing to start. Does not throw.
   */
  static auth0Options(
    config: ConfigService,
  ): Record<string, string | undefined> {
    const value = (key: string) => config.get<string>(key)?.trim() || undefined;
    return {
      AUTH0_URL: value('AUTH0_URL'),
      AUTH0_AUDIENCE: value('AUTH0_AUDIENCE'),
      AUTH0_PROXY_SERVER_URL: value('AUTH0_PROXY_SERVER_URL'),
      AUTH0_CLIENT_ID: value('AUTH0_CLIENT_ID'),
      AUTH0_CLIENT_SECRET: value('AUTH0_CLIENT_SECRET'),
    };
  }

  /**
   * Obtains a token from the active provider: `KEYCLOAK_CLIENT_ID`/`SECRET` (and
   * optional `KEYCLOAK_SCOPE`) when `USE_KEYCLOAK=true`, otherwise
   * `AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET` against Auth0.
   * Takes no parameters; used by downstream integration clients.
   * @returns An access token (Keycloak tokens are verified and unexpired).
   * @throws Error for missing configuration or failed issuance/validation; a Keycloak
   * failure never falls back to Auth0.
   */
  getToken(): Promise<string> {
    return this.client.getMachineToken();
  }
}
