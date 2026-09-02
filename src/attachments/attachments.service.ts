import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { extname } from 'node:path';
import { firstValueFrom } from 'rxjs';
import { AttachmentUploadResponseDto } from './dto';

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const FILESTACK_STORE_ENDPOINT = 'https://www.filestackapi.com/api/store/S3';
const FILESTACK_DELIVERY_HOST = 'cdn.filestackcontent.com';
const FILESTACK_HANDLE_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const POLICY_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const SIGNATURE_PATTERN = /^[A-Fa-f0-9]{64}$/;
const UNSAFE_FILENAME_CHARACTERS = /\p{Cc}/u;

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

interface FilestackStoreResponse {
  filename?: unknown;
  key?: unknown;
  size?: unknown;
  type?: unknown;
  url?: unknown;
}

interface FilestackConfiguration {
  apiKey: string;
  policy?: string;
  signature?: string;
}

interface FilestackDeliveryLocation {
  handle: string;
  url: string;
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
   * @param http HTTP client used for the fixed Filestack Store endpoint.
   * @param config server-only Filestack application configuration.
   */
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Validates a Multer file, posts its raw bytes to Filestack, and normalizes
   * only canonical HTTPS Filestack delivery metadata.
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
    const endpoint = this.buildStoreUrl(configuration, filename, mimetype);

    let providerData: unknown;
    try {
      const response = await firstValueFrom(
        this.http.post<unknown>(endpoint, file.buffer, {
          headers: {
            'Content-Length': String(file.buffer.length),
            'Content-Type': mimetype,
          },
          maxBodyLength: MAX_ATTACHMENT_BYTES,
          maxContentLength: 64 * 1024,
          maxRedirects: 0,
          timeout: 30_000,
        }),
      );
      providerData = response.data;
    } catch (error) {
      this.throwProviderError(error);
    }

    const data = this.validateStoreResponse(providerData);
    const delivery = this.validateDeliveryUrl(data.url);
    return {
      filename,
      handle: delivery.handle,
      ...this.optionalStorageKey(data.key),
      mimetype,
      size: file.buffer.length,
      url: this.buildDeliveryUrl(delivery, configuration),
    };
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
   * @returns API key and an optional complete policy/signature pair.
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
    const securityPairIsAbsent = !policy && !signature;
    const securityPairIsValid =
      policy.length >= 10 &&
      policy.length <= 8192 &&
      POLICY_PATTERN.test(policy) &&
      SIGNATURE_PATTERN.test(signature);
    if (!apiKeyIsValid || (!securityPairIsAbsent && !securityPairIsValid)) {
      this.logger.error('Filestack attachment upload is not configured.');
      throw new ServiceUnavailableException(
        'Attachment uploads are not configured.',
      );
    }
    return {
      apiKey,
      ...(securityPairIsValid ? { policy, signature } : {}),
    };
  }

  /**
   * Constructs the fixed Filestack Basic Store URL with encoded server values.
   *
   * @param configuration validated server-side credentials.
   * @param filename normalized original filename.
   * @param mimetype validated declared MIME type.
   * @returns absolute Filestack Store endpoint URL.
   */
  private buildStoreUrl(
    configuration: FilestackConfiguration,
    filename: string,
    mimetype: string,
  ): string {
    const endpoint = new URL(FILESTACK_STORE_ENDPOINT);
    endpoint.searchParams.set('key', configuration.apiKey);
    endpoint.searchParams.set('filename', filename);
    endpoint.searchParams.set('mimetype', mimetype);
    if (configuration.policy && configuration.signature) {
      endpoint.searchParams.set('policy', configuration.policy);
      endpoint.searchParams.set('signature', configuration.signature);
    }
    return endpoint.toString();
  }

  /**
   * Narrows an untrusted Filestack response before reading its metadata.
   *
   * @param candidate provider response body.
   * @returns a response object whose individual fields remain untrusted.
   * @throws BadGatewayException when the provider body is absent or malformed.
   */
  private validateStoreResponse(candidate: unknown): FilestackStoreResponse {
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
   * Adds only the server-configured security pair to a validated delivery URL.
   *
   * @param delivery validated canonical Filestack delivery location.
   * @param configuration validated server-side credentials.
   * @returns an unsigned URL, or a signed URL for a security-enabled app.
   */
  private buildDeliveryUrl(
    delivery: FilestackDeliveryLocation,
    configuration: FilestackConfiguration,
  ): string {
    const url = new URL(delivery.url);
    if (configuration.policy && configuration.signature) {
      url.searchParams.set('policy', configuration.policy);
      url.searchParams.set('signature', configuration.signature);
    }
    return url.toString();
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
   * @param error outbound HTTP failure.
   * @throws ServiceUnavailableException for network and timeout failures.
   * @throws BadGatewayException for provider HTTP or unknown failures.
   */
  private throwProviderError(error: unknown): never {
    if (isAxiosError(error)) {
      const status = error.response?.status;
      if (status !== undefined) {
        this.logger.warn(
          `Filestack attachment upload failed with HTTP ${status}.`,
        );
        throw new BadGatewayException(
          'Attachment storage rejected the upload.',
        );
      }
      const safeCode =
        error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
          ? 'timeout'
          : 'network';
      this.logger.warn(`Filestack attachment upload ${safeCode} failure.`);
      throw new ServiceUnavailableException(
        'Attachment storage is temporarily unavailable.',
      );
    }
    this.logger.warn('Filestack attachment upload failed unexpectedly.');
    throw new BadGatewayException('Attachment storage rejected the upload.');
  }
}
