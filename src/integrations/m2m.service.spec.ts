/* Proves that the outbound M2M paths follow USE_KEYCLOAK. Synthetic values only; no external calls. */
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import createBusApiClient from 'tc-bus-api-wrapper';
import { buildBusApiClient } from './event-bus.service';
import { M2mService } from './m2m.service';

jest.mock('tc-bus-api-wrapper', () => ({
  __esModule: true,
  default: jest.fn(() => ({ postEvent: jest.fn() })),
}));

const saved = { ...process.env };
const keycloakEnv: Record<string, string> = {
  KEYCLOAK_ISSUER: 'https://keycloak.example.test/realms/test',
  KEYCLOAK_AUDIENCE: 'https://api.example.test',
  KEYCLOAK_TOKEN_URL: 'https://keycloak.example.test/m2m/token',
  KEYCLOAK_CLIENT_ID: 'm2m-support',
  KEYCLOAK_CLIENT_SECRET: 'keycloak-secret',
};
const auth0Config: Record<string, string> = {
  AUTH0_URL: 'https://tenant.example/oauth/token',
  AUTH0_AUDIENCE: 'https://api.example/',
  AUTH0_CLIENT_ID: 'auth0-support',
  AUTH0_CLIENT_SECRET: 'auth0-secret',
  BUSAPI_URL: 'https://api.example/v6',
};

/** Build a ConfigService stand-in that reads the given map. */
function configOf(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

/** Set the environment for one case; `undefined` deletes a key. */
function setEnv(env: Record<string, string | undefined>) {
  process.env = { ...saved, ...keycloakEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('USE_KEYCLOAK provider selection', () => {
  let server: Server | undefined;

  afterEach(async () => {
    process.env = { ...saved };
    jest.mocked(createBusApiClient).mockClear();
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it('maps the pre-migration AUTH0_* settings, trimmed', () => {
    expect(
      M2mService.auth0Options(
        configOf({
          AUTH0_URL: ' https://tenant.example/oauth/token ',
          AUTH0_AUDIENCE: 'https://api.example/',
          AUTH0_PROXY_SERVER_URL: '  ',
          AUTH0_CLIENT_ID: 'auth0-support',
          AUTH0_CLIENT_SECRET: 'auth0-secret',
        }),
      ),
    ).toEqual({
      AUTH0_URL: 'https://tenant.example/oauth/token',
      AUTH0_AUDIENCE: 'https://api.example/',
      AUTH0_PROXY_SERVER_URL: undefined,
      AUTH0_CLIENT_ID: 'auth0-support',
      AUTH0_CLIENT_SECRET: 'auth0-secret',
    });
  });

  it('requests Auth0 tokens with AUTH0_* when USE_KEYCLOAK=false, through the proxy when set', async () => {
    const requests: { url?: string; body: Record<string, string> }[] = [];
    server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(body) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'auth0-token' }));
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setEnv({ USE_KEYCLOAK: 'false' });
    const config = { ...auth0Config, AUTH0_URL: `${base}/oauth/token` };

    await expect(new M2mService(configOf(config)).getToken()).resolves.toBe(
      'auth0-token',
    );
    await expect(
      new M2mService(
        configOf({ ...config, AUTH0_PROXY_SERVER_URL: `${base}/proxy` }),
      ).getToken(),
    ).resolves.toBe('auth0-token');
    const body = {
      grant_type: 'client_credentials',
      client_id: 'auth0-support',
      client_secret: 'auth0-secret',
      auth0_url: `${base}/oauth/token`,
      audience: auth0Config.AUTH0_AUDIENCE,
    };
    expect(requests).toEqual([
      { url: '/oauth/token', body },
      { url: '/proxy', body },
    ]);
  });

  it('defaults to Auth0 when USE_KEYCLOAK is unset', async () => {
    setEnv({ USE_KEYCLOAK: undefined });
    await expect(new M2mService(configOf({})).getToken()).rejects.toThrow(
      'AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET are required',
    );
  });

  it('uses only the Keycloak credentials when USE_KEYCLOAK=true', async () => {
    setEnv({ USE_KEYCLOAK: 'true', KEYCLOAK_CLIENT_ID: undefined });
    await expect(
      new M2mService(configOf(auth0Config)).getToken(),
    ).rejects.toThrow(
      'KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET are required',
    );
  });

  it('gives the Bus wrapper the Auth0 settings when USE_KEYCLOAK=false', () => {
    setEnv({ USE_KEYCLOAK: 'false' });
    buildBusApiClient(
      configOf({
        ...auth0Config,
        ...keycloakEnv,
        AUTH0_PROXY_SERVER_URL: 'https://proxy.example',
      }),
    );
    expect(createBusApiClient).toHaveBeenCalledWith({
      AUTH0_URL: auth0Config.AUTH0_URL,
      AUTH0_AUDIENCE: auth0Config.AUTH0_AUDIENCE,
      AUTH0_CLIENT_ID: 'auth0-support',
      AUTH0_CLIENT_SECRET: 'auth0-secret',
      AUTH0_PROXY_SERVER_URL: 'https://proxy.example',
      BUSAPI_URL: auth0Config.BUSAPI_URL,
      KAFKA_ERROR_TOPIC: 'common.error.reporting',
    });
    expect(() =>
      buildBusApiClient(
        configOf({ ...keycloakEnv, BUSAPI_URL: auth0Config.BUSAPI_URL }),
      ),
    ).toThrow('Required integration configuration is missing: AUTH0_URL.');
  });

  it('gives the Bus wrapper the Keycloak settings when USE_KEYCLOAK=true', () => {
    setEnv({ USE_KEYCLOAK: 'true' });
    buildBusApiClient(configOf({ ...auth0Config, ...keycloakEnv }));
    expect(createBusApiClient).toHaveBeenCalledWith({
      AUTH0_URL: keycloakEnv.KEYCLOAK_TOKEN_URL,
      AUTH0_AUDIENCE: keycloakEnv.KEYCLOAK_AUDIENCE,
      AUTH0_CLIENT_ID: 'm2m-support',
      AUTH0_CLIENT_SECRET: 'keycloak-secret',
      AUTH0_PROXY_SERVER_URL: keycloakEnv.KEYCLOAK_TOKEN_URL,
      BUSAPI_URL: auth0Config.BUSAPI_URL,
      KAFKA_ERROR_TOPIC: 'common.error.reporting',
    });
    expect(() =>
      buildBusApiClient(configOf({ ...auth0Config, KEYCLOAK_AUDIENCE: 'x' })),
    ).toThrow(
      'Required integration configuration is missing: KEYCLOAK_TOKEN_URL.',
    );
  });

  it('fails fast for a USE_KEYCLOAK value other than true or false', () => {
    setEnv({ USE_KEYCLOAK: 'auth0' });
    expect(() => new M2mService(configOf(auth0Config))).toThrow(TypeError);
    expect(() => buildBusApiClient(configOf(auth0Config))).toThrow(TypeError);
  });
});
