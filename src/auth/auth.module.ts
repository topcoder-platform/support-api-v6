import { Module } from '@nestjs/common';
import { AuthMiddleware } from './auth.middleware';
import { AuthenticatedGuard } from './authenticated.guard';

/** Provides Topcoder JWT middleware and route authentication guards. */
@Module({
  exports: [AuthMiddleware, AuthenticatedGuard],
  providers: [AuthMiddleware, AuthenticatedGuard],
})
export class AuthModule {}
