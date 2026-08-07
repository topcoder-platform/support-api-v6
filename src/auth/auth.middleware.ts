import {
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { middleware } from 'tc-core-library-js';

/**
 * Resolves the authorization header preserved by supported proxy layers.
 *
 * @param headers incoming request headers.
 * @returns the first usable authorization value, or an empty string.
 * @throws Does not throw.
 */
function resolveAuthorizationHeader(headers: Request['headers']): string {
  const values = [
    headers.authorization,
    headers['x-authorization'],
    headers['x-forwarded-authorization'],
    headers['x-original-authorization'],
  ];
  for (const value of values) {
    if (Array.isArray(value)) {
      const candidate = value.find(Boolean);
      if (candidate) return candidate;
    } else if (typeof value === 'string' && value) {
      return value;
    }
  }
  return '';
}

/** Validates Topcoder bearer tokens and attaches the decoded user to requests. */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMiddleware.name);
  private readonly authenticator: ReturnType<
    typeof middleware.jwtAuthenticator
  >;

  /**
   * Configures the shared Topcoder JWT authenticator.
   *
   * @param config service environment configuration.
   * @throws Error when production starts without AUTH_SECRET.
   */
  constructor(config: ConfigService) {
    const nodeEnv = config.get<string>('NODE_ENV', 'development');
    const configuredSecret = config.get<string>('AUTH_SECRET');
    if (!configuredSecret && nodeEnv === 'production') {
      throw new Error('AUTH_SECRET is required in production.');
    }
    let issuers = config.get<string>(
      'VALID_ISSUERS',
      '["https://api.topcoder.com","https://api.topcoder-dev.com","https://topcoder.auth0.com/","https://topcoder-dev.auth0.com/","https://auth.topcoder.com/","https://auth.topcoder-dev.com/"]',
    );
    if (!issuers.trim().startsWith('[')) {
      issuers = JSON.stringify(
        issuers.split(',').map((issuer) => issuer.trim()),
      );
    }
    this.authenticator = middleware.jwtAuthenticator({
      AUTH_SECRET: configuredSecret ?? 'local-development-only-secret',
      VALID_ISSUERS: issuers,
    });
  }

  /**
   * Authenticates a bearer token when present and leaves public routes anonymous.
   *
   * @param request Express request.
   * @param response Express response.
   * @param next middleware continuation.
   * @returns the authenticator continuation result.
   * @throws UnauthorizedException through Nest when token validation fails.
   */
  use(request: Request, response: Response, next: NextFunction): unknown {
    const authorization = resolveAuthorizationHeader(request.headers);
    if (!authorization) {
      next();
      return undefined;
    }

    request.headers.authorization = authorization;
    return this.authenticator(request, response, (error?: Error) => {
      if (error) {
        this.logger.warn(`JWT authentication failed: ${error.message}`);
        next(new UnauthorizedException('Invalid authentication token.'));
        return;
      }
      next();
    });
  }
}
