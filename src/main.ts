import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

/**
 * Bootstraps the Support API with its v6 prefix, validation, CORS, and OpenAPI.
 *
 * @returns a promise that resolves after the HTTP server starts.
 * @throws Nest startup and network binding errors.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({
    credentials: true,
    origin: [
      /^https?:\/\/localhost(?::\d+)?$/i,
      /^https?:\/\/([\w-]+\.)*topcoder\.com(?::\d+)?$/i,
      /^https?:\/\/([\w-]+\.)*topcoder-dev\.com(?::\d+)?$/i,
      /^https?:\/\/([\w-]+\.)*topcoder-qa\.com(?::\d+)?$/i,
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix('v6/support');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Topcoder Support API')
    .setDescription(
      'Member support tickets, replies, read state, staff assignment, and closure.',
    )
    .setVersion('6.0')
    .addBearerAuth({
      bearerFormat: 'JWT',
      scheme: 'bearer',
      type: 'http',
    })
    .addServer('/v6/support')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('/v6/support/api-docs', app, document);

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
}

void bootstrap();
