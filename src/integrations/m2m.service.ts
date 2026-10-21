import { Injectable } from '@nestjs/common';
import { auth } from 'tc-core-library-js';

/** Provides verified Keycloak credentials for outbound service calls using the shared cache. */
@Injectable()
export class M2mService {
  private readonly client = auth.m2m();

  /**
   * Obtains a token using explicit KEYCLOAK_CLIENT_ID/SECRET and optional KEYCLOAK_SCOPE.
   * Takes no parameters; used by downstream integration clients.
   * @returns A verified, unexpired access token.
   * @throws Error for missing configuration or failed issuance/validation; never falls back to Auth0.
   */
  getToken(): Promise<string> {
    return this.client.getMachineToken();
  }
}
