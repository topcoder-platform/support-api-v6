import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

/** Performs the database readiness check used by ECS and load balancers. */
@Injectable()
export class HealthService {
  /** @param db shared Prisma database client. */
  constructor(private readonly db: DbService) {}

  /**
   * Checks that PostgreSQL accepts a lightweight query.
   *
   * @returns stable health payload.
   * @throws Prisma connectivity errors when the database is unavailable.
   */
  async check(): Promise<{ status: 'ok' }> {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
