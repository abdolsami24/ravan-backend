import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';

/** JWT payload we issue: kind 'user' (phone OTP) or 'admin' (email+password). */
export interface JwtPayload {
  sub: number; // users.id or admin_users.id
  phone?: string;
  email?: string;
  role: string; // passenger | driver | admin | super_admin | support ...
  kind: 'user' | 'admin';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'change_this_to_a_long_random_secret'),
    });
  }
  async validate(payload: JwtPayload) {
    return payload;
  }
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    if (err || !user) throw new UnauthorizedException('Missing or invalid token');
    return user;
  }
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest();
    const user: JwtPayload = req.user;
    if (!user) throw new UnauthorizedException();
    if (user.kind === 'admin') {
      // Admins: role is the admin_roles.name (super_admin, support, ...).
      // super_admin may do everything.
      if (user.role === 'super_admin' || user.role === 'admin') return true;
      if (required.includes(user.role)) return true;
      throw new ForbiddenException('Admin role not allowed here');
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException('Role not allowed here');
    }
    return true;
  }
}
