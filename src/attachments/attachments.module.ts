import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

/** Registers authenticated, server-mediated Support attachment uploads. */
@Module({
  controllers: [AttachmentsController],
  imports: [AuthModule, ConfigModule, HttpModule],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
