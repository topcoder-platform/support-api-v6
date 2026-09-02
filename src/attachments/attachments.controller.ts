import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import {
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
} from './attachments.service';
import { AttachmentUploadResponseDto } from './dto';

/** Authenticated multipart upload surface for Support attachments. */
@ApiTags('Support attachments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'A valid Topcoder user token is required.',
})
@Controller('attachments')
@UseGuards(AuthenticatedGuard)
export class AttachmentsController {
  /**
   * Creates the controller.
   *
   * @param attachments server-mediated attachment upload service.
   */
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Accepts one bounded multipart file and uploads its raw bytes to Filestack.
   *
   * @param file file populated by the in-memory Multer interceptor.
   * @returns normalized Filestack attachment metadata.
   * @throws BadRequestException when the multipart request has no file.
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fields: 0,
        files: 1,
        // Multer marks a file truncated when it reaches its byte limit. Keep
        // the transport ceiling one byte higher, then enforce the inclusive
        // 2 MiB product limit again in AttachmentsService.
        fileSize: MAX_ATTACHMENT_BYTES + 1,
      },
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Upload one Support attachment' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'A non-empty, allowlisted file no larger than 2 MiB.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AttachmentUploadResponseDto })
  @ApiResponse({ status: 400, description: 'The file is missing or unsafe.' })
  @ApiResponse({ status: 413, description: 'The file exceeds 2 MiB.' })
  @ApiResponse({
    status: 502,
    description: 'Filestack rejected the upload or returned invalid metadata.',
  })
  @ApiResponse({
    status: 503,
    description: 'Filestack is unavailable or server configuration is absent.',
  })
  async upload(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<AttachmentUploadResponseDto> {
    if (!file) {
      throw new BadRequestException('A file is required.');
    }
    return this.attachments.upload(file);
  }
}
