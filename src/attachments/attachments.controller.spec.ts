import { BadRequestException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';
import request from 'supertest';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { AttachmentsController } from './attachments.controller';
import {
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
} from './attachments.service';

/** Builds a compact Multer file for direct controller delegation tests. */
function attachmentFile(): Express.Multer.File {
  const buffer = Buffer.from('image');
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
  };
}

describe('AttachmentsController', () => {
  it('requires the multipart file field', async () => {
    const attachments = { upload: jest.fn() };
    const controller = new AttachmentsController(
      attachments as unknown as AttachmentsService,
    );

    await expect(controller.upload()).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(attachments.upload).not.toHaveBeenCalled();
  });

  it('delegates a present file to the server-mediated upload service', async () => {
    const result = {
      filename: 'screenshot.png',
      handle: 's7tdGfE5RRKFUxwsZoYv',
      mimetype: 'image/png',
      size: 5,
      url: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
    };
    const attachments = { upload: jest.fn().mockResolvedValue(result) };
    const controller = new AttachmentsController(
      attachments as unknown as AttachmentsService,
    );
    const file = attachmentFile();

    await expect(controller.upload(file)).resolves.toEqual(result);
    expect(attachments.upload).toHaveBeenCalledWith(file);
  });
});

describe('AttachmentsController multipart limits', () => {
  let app: INestApplication;
  const attachments = {
    upload: jest.fn((file: Express.Multer.File) =>
      Promise.resolve({
        filename: file.originalname,
        handle: 's7tdGfE5RRKFUxwsZoYv',
        mimetype: file.mimetype,
        size: file.buffer.length,
        url: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
      }),
    ),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AttachmentsController],
      providers: [
        AuthenticatedGuard,
        { provide: AttachmentsService, useValue: attachments },
      ],
    })
      .overrideGuard(AuthenticatedGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v6/support');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    attachments.upload.mockClear();
  });

  it('accepts one multipart file at exactly the 2 MiB boundary', async () => {
    const response = await request(app.getHttpServer())
      .post('/v6/support/attachments')
      .attach('file', Buffer.alloc(MAX_ATTACHMENT_BYTES, 1), {
        contentType: 'image/png',
        filename: 'boundary.png',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      filename: 'boundary.png',
      mimetype: 'image/png',
      size: MAX_ATTACHMENT_BYTES,
    });
    expect(attachments.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        originalname: 'boundary.png',
        size: MAX_ATTACHMENT_BYTES,
      }),
    );
  });

  it('rejects a multipart file larger than 2 MiB before provider delivery', async () => {
    await request(app.getHttpServer())
      .post('/v6/support/attachments')
      .attach('file', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1), {
        contentType: 'image/png',
        filename: 'too-large.png',
      })
      .expect(413);

    expect(attachments.upload).not.toHaveBeenCalled();
  });

  it('rejects a multipart request without the file field', async () => {
    await request(app.getHttpServer())
      .post('/v6/support/attachments')
      .expect(400);

    expect(attachments.upload).not.toHaveBeenCalled();
  });
});
