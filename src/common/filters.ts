import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/** One consistent error shape: { statusCode, message, error? } */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';
    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${status}`, (exception as Error)?.stack);
    }
    res.status(status).json({
      statusCode: status,
      message: typeof message === 'string' ? message : (message as any).message || message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
