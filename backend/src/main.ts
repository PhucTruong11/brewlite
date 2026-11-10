import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { createBadRequestException } from './common/http-exceptions.js';

function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): string[] {
  return errors.flatMap((error) => {
    const propertyPath = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;

    const ownErrors = Object.values(error.constraints ?? {}).map(
      (message) => `${propertyPath}.${message}`,
    );

    const childErrors = flattenValidationErrors(
      error.children ?? [],
      propertyPath,
    );

    return [...ownErrors, ...childErrors];
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Kích hoạt middleware đọc Cookie từ Browser gửi lên (Phục vụ JWT Authentication)
  app.use(cookieParser()); // 👈 Bổ sung dòng này

  // Global prefix cho tất cả routes: /api/*
  app.setGlobalPrefix('api');

  // CORS - cho phép frontend gọi API
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true, // Cho phép gửi cookie (JWT)
  });

  // Global validation pipe - tự động validate DTO
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,       // Loại bỏ các field không có trong DTO
      forbidNonWhitelisted: true, // Throw error nếu gửi field lạ
      transform: true,       // Tự động transform types
      exceptionFactory: (errors) => {
        return createBadRequestException(flattenValidationErrors(errors));
      },
    }),
  );

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 BrewLite API is running on: http://localhost:${port}/api`);
}
await bootstrap();
