import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { of, throwError } from 'rxjs';
import {
  AttachmentsService,
  filestackUploadTimeout,
  MAX_ATTACHMENT_BYTES,
} from './attachments.service';

/** Builds a Multer memory-storage file for attachment service tests. */
function attachmentFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  const buffer = overrides.buffer ?? Buffer.from('safe image bytes');
  return {
    buffer,
    destination: '',
    encoding: '7bit',
    fieldname: 'file',
    filename: '',
    mimetype: 'image/png',
    originalname: 'screenshot.png',
    path: '',
    size: buffer.length,
    stream: Readable.from(buffer),
    ...overrides,
  };
}

/** Builds the service around observable HTTP and configuration doubles. */
function createHarness(
  configurationOverrides: Record<string, string | undefined> = {},
) {
  const http = { post: jest.fn() };
  const configuration: Record<string, string | undefined> = {
    FILESTACK_API_KEY: 'filestack-key-123',
    FILESTACK_SECURITY_POLICY: undefined,
    FILESTACK_SECURITY_SIGNATURE: undefined,
    ...configurationOverrides,
  };
  const config = {
    get: jest.fn((key: string) => configuration[key]),
  };
  const service = new AttachmentsService(
    http as unknown as HttpService,
    config as unknown as ConfigService,
  );
  return { config, http, service };
}

describe('AttachmentsService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts raw bytes to the fixed Filestack Store API and normalizes metadata', async () => {
    const { http, service } = createHarness();
    const file = attachmentFile();
    http.post.mockReturnValue(
      of({
        data: {
          filename: 'screenshot.png',
          key: 'stored_screenshot.png',
          size: file.size,
          type: 'image/png',
          url: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
        },
      }),
    );

    await expect(service.upload(file)).resolves.toEqual({
      filename: 'screenshot.png',
      handle: 's7tdGfE5RRKFUxwsZoYv',
      key: 'stored_screenshot.png',
      mimetype: 'image/png',
      size: file.buffer.length,
      url: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
    });

    expect(http.post).toHaveBeenCalledTimes(1);
    const [rawUrl, body, requestConfig] = http.post.mock.calls[0] as [
      string,
      Buffer,
      {
        headers: Record<string, string>;
        maxBodyLength: number;
        maxContentLength: number;
        maxRedirects: number;
        timeout: number;
      },
    ];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.filestackapi.com/api/store/S3',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filename: 'screenshot.png',
      key: 'filestack-key-123',
      mimetype: 'image/png',
    });
    expect(body).toBe(file.buffer);
    expect(requestConfig).toMatchObject({
      headers: {
        'Content-Length': String(file.buffer.length),
        'Content-Type': 'image/png',
      },
      maxBodyLength: MAX_ATTACHMENT_BYTES,
      maxContentLength: 64 * 1024,
      maxRedirects: 0,
      timeout: 10_000,
    });
  });

  it('keeps the provider deadline below the public gateway timeout', () => {
    const config = {
      get: jest.fn().mockReturnValue('60000'),
    } as unknown as ConfigService;

    expect(filestackUploadTimeout(config)).toBe(20_000);
  });

  it.each([null, undefined, 'not-an-object', []])(
    'maps a malformed successful provider body to a bounded gateway error',
    async (data) => {
      const { http, service } = createHarness();
      http.post.mockReturnValue(of({ data }));

      await expect(service.upload(attachmentFile())).rejects.toMatchObject({
        message: 'Attachment storage returned invalid metadata.',
        status: 502,
      });
    },
  );

  it.each([
    attachmentFile({ buffer: Buffer.alloc(0), size: 0 }),
    attachmentFile({
      mimetype: 'image/svg+xml',
      originalname: 'active.svg',
    }),
    attachmentFile({ mimetype: 'text/html', originalname: 'page.html' }),
    attachmentFile({ mimetype: 'image/png', originalname: 'renamed.exe' }),
  ])(
    'rejects empty, oversized, and unsafe content before delivery',
    async (file) => {
      const { http, service } = createHarness();

      await expect(service.upload(file)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(http.post).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized content before provider delivery', async () => {
    const { http, service } = createHarness();
    const file = attachmentFile({
      buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
      size: MAX_ATTACHMENT_BYTES + 1,
    });

    await expect(service.upload(file)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    { FILESTACK_API_KEY: undefined },
    { FILESTACK_SECURITY_POLICY: 'policy_value_123' },
    { FILESTACK_SECURITY_SIGNATURE: 'a'.repeat(64) },
    {
      FILESTACK_SECURITY_POLICY: 'policy_value_123',
      FILESTACK_SECURITY_SIGNATURE: 'not-a-signature',
    },
    {
      FILESTACK_SECURITY_POLICY: 'policy+/value_123==',
      FILESTACK_SECURITY_SIGNATURE: 'a'.repeat(64),
    },
  ])(
    'fails closed for missing or unsupported server configuration',
    async (overrides) => {
      const { http, service } = createHarness(overrides);

      await expect(service.upload(attachmentFile())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(http.post).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
    'https://evil.example/s7tdGfE5RRKFUxwsZoYv',
    'https://cdn.filestackcontent.com/resize=width:10/s7tdGfE5RRKFUxwsZoYv',
    'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv?redirect=evil',
  ])('rejects a non-canonical provider delivery URL', async (url) => {
    const { http, service } = createHarness();
    http.post.mockReturnValue(of({ data: { url } }));

    await expect(service.upload(attachmentFile())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps provider HTTP errors without returning response bodies or credentials', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { http, service } = createHarness();
    http.post.mockReturnValue(
      throwError(() => ({
        isAxiosError: true,
        message: 'filestack-key-123 and private provider body',
        response: { data: 'private provider body', status: 403 },
      })),
    );

    await expect(service.upload(attachmentFile())).rejects.toMatchObject({
      message: 'Attachment storage rejected the upload.',
      status: 502,
    });
    expect(warning).toHaveBeenCalledWith(
      'Filestack attachment upload failed with HTTP 403.',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'filestack-key-123',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'private provider body',
    );
  });

  it('maps provider network failures to a retryable service error', async () => {
    const { http, service } = createHarness();
    http.post.mockReturnValue(
      throwError(() => ({
        code: 'ETIMEDOUT',
        isAxiosError: true,
        message: 'socket details',
      })),
    );

    await expect(service.upload(attachmentFile())).rejects.toMatchObject({
      message: 'Attachment storage is temporarily unavailable.',
      status: 503,
    });
  });
});
