import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { buildSupportActor } from './actor.util';
import { SupportAuthenticatedRequest } from './auth.types';

/** Requires an authenticated human Topcoder user for ticket routes. */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  /**
   * Validates the request principal and caches its normalized actor form.
   *
   * @param context Nest execution context.
   * @returns true for authenticated human users.
   * @throws UnauthorizedException when no JWT user is present.
   * @throws ForbiddenException for inbound M2M tokens.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & SupportAuthenticatedRequest>();
    if (!request.authUser) {
      throw new UnauthorizedException('Authentication is required.');
    }
    const actor = buildSupportActor(request.authUser);
    if (actor.isMachine) {
      throw new ForbiddenException(
        'Machine tokens are not accepted by member support routes.',
      );
    }
    request.supportActor = actor;
    return true;
  }
}
