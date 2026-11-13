import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters';
import { LoggingInterceptor } from './common/logging';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(helmet.default());
  app.enableCors({ origin: true, credentials: true });
  // Global rate limit: 300 requests / 15 min per IP.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { statusCode: 429, message: 'Too many requests, please try again later.' },
    }),
  );
  // Stricter limit on the OTP endpoints (brute-force protection).
  app.use(
    '/auth/request-otp',
    rateLimit({
      windowMs: 10 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: { statusCode: 429, message: 'Too many OTP requests, please wait 10 minutes.' },
    }),
  );
  app.use(
    '/auth/verify-otp',
    rateLimit({
      windowMs: 10 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { statusCode: 429, message: 'Too many OTP attempts, please wait 10 minutes.' },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.setGlobalPrefix('api');

  const swagger = new DocumentBuilder()
    .setTitle('RAVAN API')
    .setDescription(
      'Motorcycle ride-hailing platform for Kabul — REST API (prototype, Phase 4). ' +
        'Auth: phone OTP for passengers/drivers, email+password for admins. ' +
        'Cash payment in v1. Pricing is configurable via /admin/pricing.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(config.get<string>('PORT', '3000'));
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`RAVEN backend listening on http://localhost:${port} — docs at /api/docs`);
}
bootstrap();
