import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { InvalidTransitionError, MoneyError, NegotiationError, RecurrenceError } from '@trades/domain';

export class AppError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string, public readonly details?: unknown) {
    super(message);
  }
}
export class NotFoundError extends AppError { constructor(m = 'Not found') { super(m, 404, 'not_found'); } }
export class ForbiddenError extends AppError { constructor(m = 'Forbidden') { super(m, 403, 'forbidden'); } }
export class ConflictError extends AppError { constructor(m: string, code = 'conflict') { super(m, 409, code); } }
export class ValidationError extends AppError { constructor(m: string, details?: unknown) { super(m, 422, 'validation_failed', details); } }
export class RateLimitedError extends AppError { constructor(m = 'Too many requests') { super(m, 429, 'rate_limited'); } }
export class UnauthorizedError extends AppError { constructor(m = 'Unauthorized', code = 'unauthorized') { super(m, 401, code); } }

/** Maps domain + database errors to consistent JSON: { error: { code, message, details } }. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Something went wrong';
    let details: unknown;

    if (exception instanceof AppError) {
      ({ status, code, message, details } = exception);
    } else if (exception instanceof InvalidTransitionError) {
      status = 409; code = 'invalid_state'; message = exception.message;
    } else if (exception instanceof NegotiationError || exception instanceof MoneyError || exception instanceof RecurrenceError) {
      status = 422; code = 'validation_failed'; message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      code = status === 400 ? 'bad_request' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'http_error';
      message = Array.isArray(r?.message) ? r.message.join('; ') : r?.message ?? exception.message;
      details = Array.isArray(r?.message) ? r.message : undefined;
    } else if (exception?.code === '23505') {
      status = 409; code = 'duplicate'; message = 'This action conflicts with an existing record';
      details = { constraint: exception.constraint };
    } else if (exception?.code === '23503') {
      status = 422; code = 'invalid_reference'; message = 'A referenced record does not exist';
    } else if (exception?.code === '23514') {
      status = 422; code = 'constraint_violation'; message = 'Value rejected by a business rule';
      details = { constraint: exception.constraint };
    } else if (exception?.code === 'P0001' || exception?.code === 'P0002') {
      status = 409; code = 'integrity_guard'; message = exception.message;
    }

    if (status >= 500) this.log.error(`${req?.method} ${req?.url} → ${exception?.stack ?? exception}`);
    res.status(status).json({ error: { code, message, details, requestId: req?.id } });
  }
}
