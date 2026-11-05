import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createM2MClient, type M2MClient } from 'tc-core-library-js';

/** Uses the shared M2M provider for cached, deduplicated Topcoder access tokens. */
@Injectable()
export class M2mService {
  private client?: M2MClient;

  /** Accepts existing DI dependencies; credentials are validated on first use and construction does not throw. */
  constructor(
    http: HttpService,
    private readonly config: ConfigService,
  ) {
    void http;
  }

  /** Returns a cached or freshly issued token; takes no arguments and rejects with sanitized auth/HTTP errors. */
  async getToken(): Promise<string> {
    this.client ??= createM2MClient({
      AUTH0_URL: this.config.get<string>('AUTH0_URL'),
      AUTH0_AUDIENCE: this.config.get<string>('AUTH0_AUDIENCE'),
      AUTH0_PROXY_SERVER_URL: this.config.get<string>('AUTH0_PROXY_SERVER_URL'),
      TOKEN_CACHE_TIME: this.config.get<string>('TOKEN_CACHE_TIME'),
    });
    return this.client.getMachineToken(
      this.config.get<string>('AUTH0_CLIENT_ID') || '',
      this.config.get<string>('AUTH0_CLIENT_SECRET') || '',
    );
  }
}
