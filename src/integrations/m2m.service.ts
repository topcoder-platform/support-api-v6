import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

interface M2mTokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * Obtains and caches the M2M bearer token used for Topcoder service calls.
 * The configured Auth0 proxy is used when present and receives the upstream
 * Auth0 URL in the same shape as `tc-core-library-js`.
 */
@Injectable()
export class M2mService {
  private cachedToken?: { token: string; expiresAt: number };
  private inFlightRequest?: Promise<string>;

  /**
   * Creates the M2M token provider.
   *
   * @param http HTTP client used for the client-credentials request.
   * @param config application configuration containing Auth0 credentials.
   */
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns a cached bearer token or obtains a fresh client-credentials token.
   * Concurrent cache misses share one request.
   *
   * @returns a valid M2M access token.
   * @throws Error when credentials are absent or the token endpoint rejects the request.
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.token;
    }
    if (this.inFlightRequest) {
      return this.inFlightRequest;
    }

    const request = this.requestToken().finally(() => {
      if (this.inFlightRequest === request) {
        this.inFlightRequest = undefined;
      }
    });
    this.inFlightRequest = request;
    return request;
  }

  /**
   * Calls Auth0 or the configured Auth0 proxy and updates the local token cache.
   *
   * @returns the newly issued access token.
   * @throws Error when required configuration or a usable token is missing.
   */
  private async requestToken(): Promise<string> {
    const auth0Url = this.required('AUTH0_URL');
    const clientId = this.required('AUTH0_CLIENT_ID');
    const clientSecret = this.required('AUTH0_CLIENT_SECRET');
    const audience = this.required('AUTH0_AUDIENCE');
    const requestUrl =
      this.config.get<string>('AUTH0_PROXY_SERVER_URL')?.trim() || auth0Url;

    const response = await firstValueFrom(
      this.http.post<M2mTokenResponse>(requestUrl, {
        audience,
        auth0_url: auth0Url,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    );
    const token = response.data?.access_token?.trim();
    if (!token) {
      throw new Error('M2M token response did not contain an access token.');
    }

    const configuredCacheSeconds = this.positiveInteger(
      this.config.get<string>('TOKEN_CACHE_TIME'),
      900,
    );
    const providerSeconds = this.positiveInteger(
      response.data?.expires_in,
      configuredCacheSeconds,
    );
    const cacheSeconds = Math.max(
      1,
      Math.min(configuredCacheSeconds, Math.max(1, providerSeconds - 60)),
    );
    this.cachedToken = {
      token,
      expiresAt: Date.now() + cacheSeconds * 1000,
    };
    return token;
  }

  /**
   * Reads one required configuration value without exposing its contents.
   *
   * @param key environment/configuration key.
   * @returns the trimmed configured value.
   * @throws Error when the value is absent.
   */
  private required(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) {
      throw new Error(`Required M2M configuration is missing: ${key}.`);
    }
    return value;
  }

  /**
   * Converts a configuration value to a positive integer fallback.
   *
   * @param value candidate numeric value.
   * @param fallback value returned when the candidate is invalid.
   * @returns a positive integer.
   */
  private positiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
