import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { middleware } from 'tc-core-library-js';
import { ConfigService } from '@nestjs/config';

/** Uses the common validator for member and Keycloak service principals on HTTP requests. */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly authenticator: ReturnType<
    typeof middleware.jwtAuthenticator
  >;

  /**
   * Initializes explicit Keycloak configuration and configured member trust.
   * @param config Environment configuration for member signing keys and issuers.
   * @throws Error when shared authentication configuration is invalid.
   */
  constructor(config: ConfigService) {
    const configuredIssuers = config.get<string>('VALID_ISSUERS') || '[]';
    const issuers = configuredIssuers.trim().startsWith('[')
      ? configuredIssuers
      : JSON.stringify(
          configuredIssuers.split(',').map((value) => value.trim()),
        );
    this.authenticator = middleware.jwtAuthenticator({
      AUTH_SECRET: config.get<string>('AUTH_SECRET'),
      VALID_ISSUERS: issuers,
    });
  }

  /**
   * Attaches a verified principal when a bearer header is present; public routes remain anonymous.
   * @param req Request containing the bearer header.
   * @param res Response passed to the shared middleware.
   * @param next Express continuation receiving sanitized authentication failures.
   * @returns Nothing; continues through next. Invalid tokens yield UnauthorizedException.
   */
  use(req: Request, res: Response, next: NextFunction): void {
    const candidates = [
      req.headers.authorization,
      req.headers['x-authorization'],
      req.headers['x-forwarded-authorization'],
      req.headers['x-original-authorization'],
    ];
    const authorization = candidates
      .flatMap((value) => value || [])
      .find(Boolean);
    if (!authorization) {
      next();
      return;
    }
    req.headers.authorization = authorization;
    this.authenticator(req, res, (error?: Error) => {
      next(
        error
          ? new UnauthorizedException('Invalid authentication token.')
          : undefined,
      );
    });
  }
}
