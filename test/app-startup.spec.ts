import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = join(__dirname, '..');

/**
 * Creates a disposable production-like directory with instrumented Prisma and
 * Node executables for exercising the container startup script.
 *
 * @param prismaExitCode exit code returned by the instrumented Prisma command.
 * @returns the fixture root and path of its ordered invocation log.
 * @throws Error when the temporary fixture cannot be created.
 */
function createStartupFixture(prismaExitCode = 0): {
  fixtureRoot: string;
  invocationLog: string;
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'support-api-startup-'));
  const invocationLog = join(fixtureRoot, 'invocations.log');
  const prismaPath = join(fixtureRoot, 'node_modules', '.bin', 'prisma');
  const nodePath = join(fixtureRoot, 'bin', 'node');

  mkdirSync(join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'bin'), { recursive: true });
  copyFileSync(
    join(projectRoot, 'appStartUp.sh'),
    join(fixtureRoot, 'appStartUp.sh'),
  );
  writeFileSync(
    prismaPath,
    `#!/bin/sh\nprintf 'prisma:%s\\n' "$*" >> "$INVOCATION_LOG"\nexit ${prismaExitCode}\n`,
  );
  writeFileSync(
    nodePath,
    '#!/bin/sh\nprintf \'node:%s\\n\' "$*" >> "$INVOCATION_LOG"\n',
  );
  chmodSync(join(fixtureRoot, 'appStartUp.sh'), 0o755);
  chmodSync(prismaPath, 0o755);
  chmodSync(nodePath, 0o755);

  return { fixtureRoot, invocationLog };
}

describe('production startup', () => {
  it('uses the migration-aware startup script in the production image', () => {
    const dockerfile = readFileSync(join(projectRoot, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('ARG ALPINE_VERSION=3.24');
    expect(dockerfile).toContain('ARG NODE_PACKAGE_VERSION=26.5.1-r0');
    expect(dockerfile).toContain('ARG OPENSSL_PACKAGE_VERSION=3.5.8-r0');
    expect(dockerfile).toContain('FROM alpine:${ALPINE_VERSION} AS production');
    expect(dockerfile).toContain('"nodejs-current=${NODE_PACKAGE_VERSION}"');
    expect(dockerfile).toContain('"libcrypto3=${OPENSSL_PACKAGE_VERSION}"');
    expect(dockerfile).toContain('"libssl3=${OPENSSL_PACKAGE_VERSION}"');
    expect(dockerfile).toContain(
      'COPY --from=build --chown=node:node --chmod=755 /usr/src/app/appStartUp.sh ./appStartUp.sh',
    );
    expect(dockerfile).toContain('CMD ["./appStartUp.sh"]');
  });

  it('applies pending migrations before starting the API', () => {
    const { fixtureRoot, invocationLog } = createStartupFixture();

    try {
      execFileSync('./appStartUp.sh', {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          INVOCATION_LOG: invocationLog,
          PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
        },
      });

      expect(readFileSync(invocationLog, 'utf8').trim().split('\n')).toEqual([
        'prisma:migrate deploy',
        'node:dist/main.js',
      ]);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it('does not start the API when a migration fails', () => {
    const { fixtureRoot, invocationLog } = createStartupFixture(1);

    try {
      expect(() =>
        execFileSync('./appStartUp.sh', {
          cwd: fixtureRoot,
          env: {
            ...process.env,
            INVOCATION_LOG: invocationLog,
            PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
          },
        }),
      ).toThrow();
      expect(readFileSync(invocationLog, 'utf8').trim()).toBe(
        'prisma:migrate deploy',
      );
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
