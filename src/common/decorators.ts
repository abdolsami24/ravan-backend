import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from './auth';
export type { JwtPayload } from './auth';

/** @CurrentUser() gives the decoded JWT payload of the caller. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    return ctx.switchToHttp().getRequest().user;
  },
);
