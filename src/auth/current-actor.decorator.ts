import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { buildSupportActor } from './actor.util';
import { SupportActor, SupportAuthenticatedRequest } from './auth.types';

/** Resolves the normalized actor cached by AuthenticatedGuard. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SupportActor => {
    const request = context
      .switchToHttp()
      .getRequest<Request & SupportAuthenticatedRequest>();
    if (request.supportActor) return request.supportActor;
    return buildSupportActor(request.authUser ?? {});
  },
);
