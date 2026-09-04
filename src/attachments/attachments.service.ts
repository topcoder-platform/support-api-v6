import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extname } from 'node:path';
import { AttachmentUploadResponseDto } from './dto';

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const FILESTACK_DELIVERY_HOST = 'cdn.filestackcontent.com';
const FILESTACK_HANDLE_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSAFE_FILENAME_CHARACTERS = /\p{Cc}/u;
const DEFAULT_FILESTACK_TIMEOUT_MS = 10_000;
const MAX_FILESTACK_TIMEOUT_MS = 20_000;

/** Identifies a complete hosted upload that exceeded its API-safe deadline. */
class FilestackUploadDeadlineError extends Error {}

const ALLOWED_MIME_TYPES_BY_EXTENSION: Readonly<
  Record<string, readonly string[]>
> = {
  '.7z': ['application/x-7z-compressed'],
  '.bmp': ['image/bmp'],
  '.csv': ['text/csv'],
  '.doc': ['application/msword'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  '.gif': ['image/gif'],
  '.gz': ['application/gzip', 'application/x-gzip'],
  '.jpeg': ['image/jpeg'],
  '.jpg': ['image/jpeg'],
  '.json': ['application/json'],
  '.log': ['text/plain'],
  '.pdf': ['application/pdf'],
  '.png': ['image/png'],
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  '.rar': ['application/vnd.rar', 'application/x-rar-compressed'],
  '.tar': ['application/x-tar'],
  '.tgz': ['application/gzip', 'application/x-gzip'],
  '.tif': ['image/tiff'],
  '.tiff': ['image/tiff'],
  '.txt': ['text/plain'],
  '.webp': ['image/webp'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  '.xml': ['application/xml', 'text/xml'],
  '.zip': ['application/zip', 'application/x-zip-compressed'],
};

interface FilestackUploadResponse {
  filename?: unknown;
  key?: unknown;
  size?: unknown;
  type?: unknown;
  url?: unknown;
}

interface FilestackConfiguration {
  apiKey: string;
}

interface FilestackDeliveryLocation {
  handle: string;
  url: string;
}

interface FilestackUploadControl {
  cancel?: () => void;
}

interface FilestackProviderError {
  details?: unknown;
  type?: unknown;
}

/**
 * Resolves an outbound Filestack deadline that remains below the public gateway timeout.
 *
 * @param config application configuration containing the shared outbound timeout.
 * @returns timeout in milliseconds, between one second and twenty seconds.
 * @throws Does not throw.
 */
export function filestackUploadTimeout(config: ConfigService): number {
  const parsed = Number(config.get<string>('OUTBOUND_HTTP_TIMEOUT_MS'));
  return Number.isInteger(parsed) && parsed >= 1_000
    ? Math.min(parsed, MAX_FILESTACK_TIMEOUT_MS)
    : DEFAULT_FILESTACK_TIMEOUT_MS;
}

/**
 * Proxies bounded Support attachments to Filestack so browsers never connect
 * directly to S3 or receive storage credentials.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  /**
   * Creates the attachment service.
   *
   * @param config server-only Filestack application configuration.
   */
  constructor(private readonly config: ConfigService) {}

  /**
   * Validates a Multer file, uploads it through Filestack's hosted multipart
   * flow, and normalizes only canonical HTTPS delivery metadata.
   *
   * @param file authenticated member upload held in memory by Multer.
   * @returns filename, handle, storage key, type, size, and delivery URL.
   * @throws BadRequestException for empty or unsafe files.
   * @throws PayloadTooLargeException for files larger than 2 MiB.
   * @throws ServiceUnavailableException for missing configuration or network failures.
   * @throws BadGatewayException for rejected uploads or invalid provider data.
   */
  async upload(
    file: Express.Multer.File,
  ): Promise<AttachmentUploadResponseDto> {
    const filename = this.validateFilename(file.originalname);
    const mimetype = this.validateFile(file, filename);
    const configuration = this.readConfiguration();

    let providerData: unknown;
    try {
      providerData = await this.uploadToFilestack(
        configuration,
        file.buffer,
        filename,
        mimetype,
      );
    } catch (error) {
      this.throwProviderError(error);
    }

    const data = this.validateUploadResponse(providerData);
    const delivery = this.validateDeliveryUrl(data.url);
    return {
      filename,
      handle: delivery.handle,
      ...this.optionalStorageKey(data.key),
      mimetype,
      size: file.buffer.length,
      url: delivery.url,
    };
  }

  /**
   * Uploads bytes with the official Filestack multipart client and default
   * hosted storage, matching the server-mediated forum media flow.
   *
   * @param configuration validated server-side Filestack credentials.
   * @param buffer validated file contents.
   * @param filename normalized original filename.
   * @param mimetype validated declared MIME type.
   * @returns untrusted Filestack upload metadata.
   * @throws A provider error or internal deadline marker for normalization by the caller.
   */
  private async uploadToFilestack(
    configuration: FilestackConfiguration,
    buffer: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<unknown> {
    const { init: initFilestack } = await import('filestack-js');
    const client = initFilestack(configuration.apiKey);
    const control: FilestackUploadControl = {};
    const timeout = filestackUploadTimeout(this.config);
    let providerError: unknown;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const rememberProviderError = (error: unknown): void => {
      providerError = error;
    };

    client.on('upload.error', rememberProviderError);
    try {
      const upload = client.upload(
        buffer,
        {
          concurrency: 1,
          retry: 1,
          retryFactor: 2,
          retryMaxTime: 1_000,
          timeout,
        },
        { filename, mimetype },
        control,
      );
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          try {
            control.cancel?.();
          } catch {
            // The deadline rejection below remains authoritative if cancellation fails.
          }
          reject(new FilestackUploadDeadlineError());
        }, timeout);
      });
      return await Promise.race([upload, deadline]);
    } catch (error) {
      if (error instanceof FilestackUploadDeadlineError) {
        throw error;
      }
      throw providerError ?? error;
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      client.removeListener('upload.error', rememberProviderError);
    }
  }

  /**
   * Validates and normalizes the browser-provided original filename.
   *
   * @param originalname Multer original filename.
   * @returns a trimmed filename without path or control characters.
   * @throws BadRequestException when the filename is absent or unsafe.
   */
  private validateFilename(originalname: string): string {
    const pathSegments = originalname.replace(/\\/g, '/').split('/');
    const filename = pathSegments[pathSegments.length - 1]?.trim() ?? '';
    if (
      !filename ||
      filename === '.' ||
      filename === '..' ||
      filename.length > 255 ||
      UNSAFE_FILENAME_CHARACTERS.test(filename)
    ) {
      throw new BadRequestException('The file name is invalid.');
    }
    return filename;
  }

  /**
   * Enforces byte and declared MIME/extension limits before provider delivery.
   *
   * @param file Multer memory-storage file.
   * @param filename normalized original filename.
   * @returns normalized allowlisted MIME type.
   * @throws BadRequestException when content is empty or unsafe.
   * @throws PayloadTooLargeException when content exceeds 2 MiB.
   */
  private validateFile(file: Express.Multer.File, filename: string): string {
    const size = file.buffer?.length ?? 0;
    if (size === 0) {
      throw new BadRequestException('The file cannot be empty.');
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('The file exceeds the 2 MiB limit.');
    }

    const extension = extname(filename).toLowerCase();
    const mimetype = file.mimetype.trim().toLowerCase();
    const allowedMimetypes = ALLOWED_MIME_TYPES_BY_EXTENSION[extension];
    if (!allowedMimetypes?.includes(mimetype)) {
      throw new BadRequestException(
        'This file type is not allowed for support attachments.',
      );
    }
    return mimetype;
  }

  /**
   * Reads and validates server-side Filestack credentials.
   *
   * @returns API key for a Filestack app with security disabled.
   * @throws ServiceUnavailableException for absent or malformed configuration.
   */
  private readConfiguration(): FilestackConfiguration {
    const apiKey = this.config.get<string>('FILESTACK_API_KEY')?.trim() ?? '';
    const policy =
      this.config.get<string>('FILESTACK_SECURITY_POLICY')?.trim() ?? '';
    const signature =
      this.config.get<string>('FILESTACK_SECURITY_SIGNATURE')?.trim() ?? '';
    const apiKeyIsValid =
      apiKey.length >= 8 &&
      apiKey.length <= 256 &&
      API_KEY_PATTERN.test(apiKey);
    if (!apiKeyIsValid || policy || signature) {
      this.logger.error('Filestack attachment upload is not configured.');
      throw new ServiceUnavailableException(
        'Attachment uploads are not configured.',
      );
    }
    return { apiKey };
  }

  /**
   * Narrows an untrusted Filestack response before reading its metadata.
   *
   * @param candidate provider response body.
   * @returns a response object whose individual fields remain untrusted.
   * @throws BadGatewayException when the provider body is absent or malformed.
   */
  private validateUploadResponse(candidate: unknown): FilestackUploadResponse {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new BadGatewayException(
        'Attachment storage returned invalid metadata.',
      );
    }
    return candidate;
  }

  /**
   * Accepts only a direct canonical Filestack CDN handle URL.
   *
   * @param candidate untrusted provider response URL.
   * @returns canonical URL and its handle.
   * @throws BadGatewayException when the provider response could redirect elsewhere.
   */
  private validateDeliveryUrl(candidate: unknown): FilestackDeliveryLocation {
    if (typeof candidate !== 'string') {
      throw new BadGatewayException(
        'Attachment storage returned invalid metadata.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new BadGatewayException(
        'Attachment storage returned invalid metadata.',
      );
    }
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const handle = pathSegments[0] ?? '';
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== FILESTACK_DELIVERY_HOST ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      pathSegments.length !== 1 ||
      !FILESTACK_HANDLE_PATTERN.test(handle)
    ) {
      throw new BadGatewayException(
        'Attachment storage returned invalid metadata.',
      );
    }
    return {
      handle,
      url: `https://${FILESTACK_DELIVERY_HOST}/${handle}`,
    };
  }

  /**
   * Copies a bounded, control-character-free optional storage key.
   *
   * @param candidate untrusted provider response key.
   * @returns an object containing the key, or an empty object.
   */
  private optionalStorageKey(candidate: unknown): { key?: string } {
    if (
      typeof candidate !== 'string' ||
      !candidate ||
      candidate.length > 1024 ||
      UNSAFE_FILENAME_CHARACTERS.test(candidate)
    ) {
      return {};
    }
    return { key: candidate };
  }

  /**
   * Converts all provider failures to bounded public errors without leaking
   * request URLs, credentials, response bodies, or uploaded content.
   *
   * @param error official SDK or provider failure.
   * @throws ServiceUnavailableException for network and timeout failures.
   * @throws BadGatewayException for provider HTTP or unknown failures.
   */
  private throwProviderError(error: unknown): never {
    if (error instanceof FilestackUploadDeadlineError) {
      this.logger.warn('Filestack attachment upload timeout failure.');
      throw new ServiceUnavailableException(
        'Attachment storage is temporarily unavailable.',
      );
    }

    const providerError =
      error && typeof error === 'object'
        ? (error as FilestackProviderError)
        : undefined;
    const details =
      providerError?.details && typeof providerError.details === 'object'
        ? (providerError.details as { code?: unknown })
        : undefined;
    const status = details?.code;
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      this.logger.warn(
        `Filestack attachment upload failed with HTTP ${status}.`,
      );
      throw new BadGatewayException('Attachment storage rejected the upload.');
    }
    if (
      providerError?.type === 'request' ||
      providerError?.type === 'aborted'
    ) {
      const safeCode = providerError.type === 'aborted' ? 'timeout' : 'network';
      this.logger.warn(`Filestack attachment upload ${safeCode} failure.`);
      throw new ServiceUnavailableException(
        'Attachment storage is temporarily unavailable.',
      );
    }
    this.logger.warn('Filestack attachment upload failed unexpectedly.');
    throw new BadGatewayException('Attachment storage rejected the upload.');
  }
}
