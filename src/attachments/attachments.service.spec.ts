import {
  BadGatewayException,
  BadRequestException,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { init as initFilestack, type Client } from 'filestack-js';
import { Readable } from 'node:stream';
import {
  AttachmentsService,
  filestackUploadTimeout,
  MAX_ATTACHMENT_BYTES,
} from './attachments.service';

jest.mock('filestack-js', () => ({
  init: jest.fn(),
}));

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

type UploadErrorListener = (error: unknown) => void;

/** Builds the service around official Filestack client and configuration doubles. */
function createHarness(
  configurationOverrides: Record<string, string | undefined> = {},
) {
  const upload = jest.fn();
  const uploadErrorListeners = new Set<UploadErrorListener>();
  const client = {
    on: jest.fn(),
    removeListener: jest.fn(),
    upload,
  };
  client.on.mockImplementation(
    (event: string, listener: UploadErrorListener): typeof client => {
      if (event === 'upload.error') {
        uploadErrorListeners.add(listener);
      }
      return client;
    },
  );
  client.removeListener.mockImplementation(
    (event: string, listener: UploadErrorListener): typeof client => {
      if (event === 'upload.error') {
        uploadErrorListeners.delete(listener);
      }
      return client;
    },
  );
  jest.mocked(initFilestack).mockReturnValue(client as unknown as Client);

  const configuration: Record<string, string | undefined> = {
    FILESTACK_API_KEY: 'filestack-key-123',
    FILESTACK_SECURITY_POLICY: undefined,
    FILESTACK_SECURITY_SIGNATURE: undefined,
    ...configurationOverrides,
  };
  const config = {
    get: jest.fn((key: string) => configuration[key]),
  };
  const service = new AttachmentsService(config as unknown as ConfigService);
  const emitUploadError = (error: unknown): void => {
    uploadErrorListeners.forEach((listener) => listener(error));
  };
  return { client, config, emitUploadError, service, upload };
}

describe('AttachmentsService', () => {
  beforeEach(() => {
    jest.mocked(initFilestack).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses the official hosted upload without custom S3 storage targeting', async () => {
    const { client, service, upload } = createHarness();
    const file = attachmentFile();
    upload.mockResolvedValue({
      filename: 'screenshot.png',
      key: 'stored_screenshot.png',
      size: file.size,
      type: 'image/png',
      url: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
    });

    await expect(service.upload(file)).resolves.toEqual({
      filename: 'screenshot.png',
      handle: 's7tdGfE5RRKFUxwsZoYv',
      key: 'stored_screenshot.png',
      mimetype: 'image/png',
      size: file.buffer.length,
      url: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
    });

    expect(initFilestack).toHaveBeenCalledWith('filestack-key-123');
    expect(upload).toHaveBeenCalledTimes(1);
    const [body, uploadOptions, storeOptions, control, security] = upload.mock
      .calls[0] as [Buffer, object, Record<string, unknown>, object, unknown?];
    expect(body).toBe(file.buffer);
    expect(uploadOptions).toEqual({
      concurrency: 1,
      retry: 1,
      retryFactor: 2,
      retryMaxTime: 1_000,
      timeout: 10_000,
    });
    expect(storeOptions).toEqual({
      filename: 'screenshot.png',
      mimetype: 'image/png',
    });
    expect(storeOptions).not.toHaveProperty('container');
    expect(storeOptions).not.toHaveProperty('location');
    expect(storeOptions).not.toHaveProperty('path');
    expect(storeOptions).not.toHaveProperty('region');
    expect(control).toEqual(
      expect.not.objectContaining({
        container: expect.anything(),
        path: expect.anything(),
        region: expect.anything(),
      }),
    );
    expect(security).toBeUndefined();
    const errorListener = client.on.mock.calls[0][1] as UploadErrorListener;
    expect(client.on).toHaveBeenCalledWith('upload.error', errorListener);
    expect(client.removeListener).toHaveBeenCalledWith(
      'upload.error',
      errorListener,
    );
  });

  it('keeps the complete provider upload below the public gateway timeout', () => {
    const config = {
      get: jest.fn().mockReturnValue('60000'),
    } as unknown as ConfigService;

    expect(filestackUploadTimeout(config)).toBe(20_000);
  });

  it.each([null, undefined, 'not-an-object', []])(
    'maps malformed successful provider metadata to a bounded gateway error',
    async (data) => {
      const { service, upload } = createHarness();
      upload.mockResolvedValue(data);

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
  ])('rejects empty and unsafe content before delivery', async (file) => {
    const { service, upload } = createHarness();

    await expect(service.upload(file)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(initFilestack).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects oversized content before provider delivery', async () => {
    const { service, upload } = createHarness();
    const file = attachmentFile({
      buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
      size: MAX_ATTACHMENT_BYTES + 1,
    });

    await expect(service.upload(file)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(initFilestack).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
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
      const { service, upload } = createHarness(overrides);

      await expect(service.upload(attachmentFile())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(initFilestack).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
    'https://evil.example/s7tdGfE5RRKFUxwsZoYv',
    'https://cdn.filestackcontent.com/resize=width:10/s7tdGfE5RRKFUxwsZoYv',
    'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv?redirect=evil',
  ])('rejects a non-canonical provider delivery URL', async (url) => {
    const { service, upload } = createHarness();
    upload.mockResolvedValue({ url });

    await expect(service.upload(attachmentFile())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps provider HTTP errors without returning bodies or credentials', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { emitUploadError, service, upload } = createHarness();
    upload.mockImplementation(() => {
      emitUploadError({
        details: { code: 403, data: 'private provider body' },
        message: 'filestack-key-123 and private provider body',
        type: 'request',
      });
      return Promise.reject(new Error('SDK returned a failed file'));
    });

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

  it.each([429, 500, 502, 503, 504])(
    'maps provider HTTP %s to temporary storage unavailability',
    async (code) => {
      const { emitUploadError, service, upload } = createHarness();
      upload.mockImplementation(() => {
        emitUploadError({ details: { code }, type: 'request' });
        return Promise.reject(new Error('SDK returned a failed file'));
      });

      await expect(service.upload(attachmentFile())).rejects.toMatchObject({
        message: 'Attachment storage is temporarily unavailable.',
        status: 503,
      });
    },
  );

  it.each(['request', 'aborted', 'timeout'])(
    'maps provider %s failures to a retryable service error',
    async (type) => {
      const { emitUploadError, service, upload } = createHarness();
      upload.mockImplementation(() => {
        emitUploadError({
          details: {},
          message: 'socket details',
          type,
        });
        return Promise.reject(new Error('SDK returned a failed file'));
      });

      await expect(service.upload(attachmentFile())).rejects.toMatchObject({
        message: 'Attachment storage is temporarily unavailable.',
        status: 503,
      });
    },
  );

  it('cancels a stalled SDK upload at the bounded provider deadline', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    const { service, upload } = createHarness({
      OUTBOUND_HTTP_TIMEOUT_MS: '1000',
    });
    upload.mockImplementation(
      (
        _body: Buffer,
        _uploadOptions: object,
        _storeOptions: object,
        control: { cancel?: () => void },
      ) => {
        control.cancel = cancel;
        return new Promise(() => undefined);
      },
    );

    const result = expect(
      service.upload(attachmentFile()),
    ).rejects.toMatchObject({
      message: 'Attachment storage is temporarily unavailable.',
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
