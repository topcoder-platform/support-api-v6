import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/** Prisma 7 PostgreSQL client shared by all application modules. */
@Injectable()
export class DbService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /**
   * Creates a Prisma client using the Prisma 7 PostgreSQL driver adapter.
   *
   * @param config application configuration containing the database URL.
   * @throws Prisma configuration errors for an invalid connection string.
   */
  constructor(config: ConfigService) {
    const connectionString =
      config.get<string>('SUPPORT_DATABASE_URL') ??
      config.get<string>('DATABASE_URL') ??
      'postgresql://postgres:postgres@localhost:5432/topcoder?schema=support';
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  /** Connects Prisma when the Nest module starts. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Disconnects Prisma during graceful application shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
