import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { HttpAdapter } from 'filestack-js/build/main/lib/request/adapters/http';
import { FsCancelToken } from 'filestack-js/build/main/lib/request/token';
import { FsHttpMethod } from 'filestack-js/build/main/lib/request/types';

// Jest 29 cannot load file-type's ESM entrypoint. MIME sniffing is unused by
// these transport tests; the installed SDK adapter and streams remain real.
jest.mock(
  require.resolve('file-type', { paths: [require.resolve('filestack-js')] }),
  () => ({}),
);

/**
 * Supplies a Node request double to the installed Filestack HTTP adapter.
 * Tests retain the SDK's real upload streams and cancellation handling.
 *
 * @returns controllable request and response callbacks, without opening sockets.
 * @throws Does not throw.
 */
function createTransport() {
  const request = Object.assign(new EventEmitter(), {
    abort: jest.fn(),
    destroy: jest.fn(),
    end: jest.fn(),
    setTimeout: jest.fn(),
    write: jest.fn(
      (
        _chunk: Buffer,
        _encoding: string,
        callback: (error?: Error) => void,
      ) => {
        setImmediate(callback);
        return true;
      },
    ),
  });
  const send = jest
    .spyOn(http, 'request')
    .mockReturnValue(request as unknown as http.ClientRequest);
  return { request, send };
}

describe('Filestack Node HTTP transport patch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects asynchronous upload write failures without an unhandled stream error', async () => {
    const { request } = createTransport();
    request.write.mockImplementation((_chunk, _encoding, callback) => {
      setImmediate(callback, new Error('write ECONNRESET'));
      return false;
    });

    await expect(
      new HttpAdapter().request({
        data: Buffer.alloc(64 * 1024),
        method: FsHttpMethod.POST,
        url: 'http://filestack.test/upload',
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('handles a canceled in-flight write after the request promise rejects', async () => {
    const { request } = createTransport();
    const cancelToken = new FsCancelToken();
    request.write.mockImplementation((_chunk, _encoding, callback) => {
      setImmediate(() => {
        cancelToken.cancel();
        callback(
          new Error('write ECANCELED Canceled because of SSL destruction'),
        );
      });
      return false;
    });

    await expect(
      new HttpAdapter().request({
        cancelToken,
        data: Buffer.alloc(64 * 1024),
        method: FsHttpMethod.POST,
        url: 'http://filestack.test/upload',
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(request.abort).toHaveBeenCalledTimes(1);
  });

  it('rejects an interrupted provider response without dereferencing a cleared request', async () => {
    const { send } = createTransport();
    const result = expect(
      new HttpAdapter().request({
        method: FsHttpMethod.GET,
        url: 'http://filestack.test/response',
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    const respond = send.mock.calls[0][1] as unknown as (
      response: unknown,
    ) => void;
    const response = Object.assign(new EventEmitter(), {
      headers: {},
      statusCode: 200,
    });
    respond(response);
    response.emit('error', new Error('connection closed'));
    await result;
  });

  it('delivers every byte of a maximum-sized attachment and parses the provider response', async () => {
    const { request, send } = createTransport();
    const data = Buffer.alloc(2 * 1024 * 1024, 'a');
    const metadata = {
      url: 'https://cdn.filestackcontent.com/abcdefghijklmno',
    };
    request.end.mockImplementation(() => {
      const respond = send.mock.calls[0][1] as unknown as (
        response: unknown,
      ) => void;
      respond(
        Object.assign(Readable.from([Buffer.from(JSON.stringify(metadata))]), {
          headers: { 'content-type': 'application/json' },
          statusCode: 200,
        }),
      );
    });

    await expect(
      new HttpAdapter().request({
        data,
        method: FsHttpMethod.POST,
        url: 'http://filestack.test/upload',
      }),
    ).resolves.toMatchObject({ data: metadata, status: 200 });
    expect(
      Buffer.concat(request.write.mock.calls.map(([chunk]) => chunk)),
    ).toEqual(data);
  });
});
