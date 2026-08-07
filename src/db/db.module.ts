import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';

/** Exposes one process-wide Prisma database client. */
@Global()
@Module({
  exports: [DbService],
  providers: [DbService],
})
export class DbModule {}
