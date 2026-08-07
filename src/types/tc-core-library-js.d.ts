declare module 'tc-core-library-js' {
  import type { Request, Response } from 'express';

  /** Configuration consumed by the shared Topcoder JWT middleware. */
  interface JwtAuthenticatorConfig {
    AUTH_SECRET: string;
    VALID_ISSUERS: string;
  }

  /** Express-compatible authentication middleware function. */
  type JwtAuthenticator = (
    request: Request,
    response: Response,
    next: (error?: Error) => void,
  ) => unknown;

  /** Topcoder core authentication middleware factory exports. */
  export const middleware: {
    jwtAuthenticator(config: JwtAuthenticatorConfig): JwtAuthenticator;
  };
}
