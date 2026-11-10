import { BadRequestException } from '@nestjs/common';

export function createBadRequestException(
  messages: string | string[],
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: Array.isArray(messages) ? messages : [messages],
    error: 'Bad Request',
  });
}
