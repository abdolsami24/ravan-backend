import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtStrategy, JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';
import { generateOtp } from '../common/utils';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
export class RequestOtpDto {
  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be digits, optionally starting with +' })
  phone!: string;

  @IsEnum(['passenger', 'driver'])
  role!: 'passenger' | 'driver';
}

export class VerifyOtpDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsString() @Length(6, 6) otp!: string;
}

export class RegisterPassengerDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsEnum(['fa', 'ps', 'en']) language!: 'fa' | 'ps' | 'en';
  @IsOptional() @IsNumber() home_lat?: number;
  @IsOptional() @IsNumber() home_lng?: number;
  @IsOptional() @IsString() home_address?: string;
  @IsOptional() @IsNumber() work_lat?: number;
  @IsOptional() @IsNumber() work_lng?: number;
  @IsOptional() @IsString() work_address?: string;
}

export class RegisterDriverDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsEnum(['fa', 'ps', 'en']) language!: 'fa' | 'ps' | 'en';
  @IsString() @IsNotEmpty() license_number!: string;
  @IsString() @IsNotEmpty() brand!: string;
  @IsString() @IsNotEmpty() model!: string;
  @IsOptional() @IsNumber() year?: number;
  @IsOptional() @IsString() color?: string;
  @IsString() @IsNotEmpty() plate_number!: string;
}

export class AdminLoginDto {
  @IsString() @IsNotEmpty() email!: string;
  @IsString() @IsNotEmpty() password!: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private get otpDevMode(): boolean {
    return this.config.get<string>('OTP_DEV_MODE', 'true') === 'true';
  }
  private get otpTtlSeconds(): number {
    return Number(this.config.get<string>('OTP_TTL_SECONDS', '300'));
  }

  private signToken(payload: JwtPayload) {
    return this.jwt.sign(payload);
  }

  /**
   * Request a 6-digit OTP for a phone number.
   * PROTOTYPE / DEV MODE: no SMS provider is wired yet, so the OTP is
   * returned in the response and logged to the console. In production this
   * MUST send the OTP via SMS and must never return it in the response.
   */
  async requestOtp(dto: RequestOtpDto) {
    const otp = generateOtp();
    const hash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + this.otpTtlSeconds * 1000);
    const expiresSql = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

    const existing = await this.db.queryOne<{ id: number; status: string }>(
      'SELECT id, status FROM users WHERE phone = ?',
      [dto.phone],
    );
    if (existing) {
      if (existing.status !== 'active') {
        throw new HttpException('Account is not active', HttpStatus.FORBIDDEN);
      }
      await this.db.query(
        'UPDATE users SET otp_code = ?, otp_expires_at = ? WHERE id = ?',
        [hash, expiresSql, existing.id],
      );
    } else {
      await this.db.query(
        `INSERT INTO users (phone, role, name, language, otp_code, otp_expires_at)
         VALUES (?, ?, 'New user', 'fa', ?, ?)`,
        [dto.phone, dto.role, hash, expiresSql],
      );
    }

    if (this.otpDevMode) {
      // DEV ONLY — never do this in production.
      // eslint-disable-next-line no-console
      console.log(`[OTP DEV] phone=${dto.phone} otp=${otp} expires in ${this.otpTtlSeconds}s`);
      return {
        phone: dto.phone,
        expires_in_seconds: this.otpTtlSeconds,
        dev_otp: otp,
        note: 'DEV MODE: no SMS provider yet. The OTP is returned here for testing only.',
      };
    }
    return { phone: dto.phone, expires_in_seconds: this.otpTtlSeconds };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.db.queryOne<{
      id: number; phone: string; role: string; name: string; status: string;
      otp_code: string | null; otp_expires_at: string | null;
    }>('SELECT * FROM users WHERE phone = ?', [dto.phone]);
    if (!user || !user.otp_code || !user.otp_expires_at) {
      throw new HttpException('No OTP requested for this phone', HttpStatus.BAD_REQUEST);
    }
    if (new Date(user.otp_expires_at).getTime() < Date.now()) {
      throw new HttpException('OTP expired, request a new one', HttpStatus.BAD_REQUEST);
    }
    const ok = await bcrypt.compare(dto.otp, user.otp_code);
    if (!ok) throw new HttpException('Wrong OTP', HttpStatus.UNAUTHORIZED);
    await this.db.query(
      'UPDATE users SET otp_code = NULL, otp_expires_at = NULL WHERE id = ?',
      [user.id],
    );
    const token = this.signToken({ sub: user.id, phone: user.phone, role: user.role, kind: 'user' });
    return {
      access_token: token,
      user: { id: user.id, phone: user.phone, role: user.role, name: user.name },
    };
  }

  async registerPassenger(user: JwtPayload, dto: RegisterPassengerDto) {
    if (user.role !== 'passenger') {
      throw new HttpException('Only passengers can register a passenger profile', HttpStatus.FORBIDDEN);
    }
    await this.db.query('UPDATE users SET name = ?, language = ? WHERE id = ?', [
      dto.name, dto.language, user.sub,
    ]);
    await this.db.query(
      `INSERT INTO passengers (user_id, home_lat, home_lng, home_address, work_lat, work_lng, work_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE home_lat=VALUES(home_lat), home_lng=VALUES(home_lng),
         home_address=VALUES(home_address), work_lat=VALUES(work_lat), work_lng=VALUES(work_lng),
         work_address=VALUES(work_address)`,
      [user.sub, dto.home_lat ?? null, dto.home_lng ?? null, dto.home_address ?? null,
       dto.work_lat ?? null, dto.work_lng ?? null, dto.work_address ?? null],
    );
    return { ok: true, message: 'Passenger profile saved' };
  }

  async registerDriver(user: JwtPayload, dto: RegisterDriverDto) {
    if (user.role !== 'driver') {
      throw new HttpException('Only drivers can register a driver profile', HttpStatus.FORBIDDEN);
    }
    await this.db.transaction(async (conn) => {
      await conn.execute('UPDATE users SET name = ?, language = ? WHERE id = ?', [
        dto.name, dto.language, user.sub,
      ]);
      const [driverRows]: any = await conn.execute(
        'SELECT id FROM drivers WHERE user_id = ?',
        [user.sub],
      );
      let driverId: number;
      if (driverRows.length) {
        driverId = driverRows[0].id;
        await conn.execute(
          'UPDATE drivers SET license_number = ?, status = ? WHERE id = ?',
          [dto.license_number, 'pending', driverId],
        );
      } else {
        const [res]: any = await conn.execute(
          `INSERT INTO drivers (user_id, status, license_number) VALUES (?, 'pending', ?)`,
          [user.sub, dto.license_number],
        );
        driverId = res.insertId;
      }
      await conn.execute(
        `INSERT INTO motorcycles (driver_id, brand, model, year, color, plate_number, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE brand=VALUES(brand), model=VALUES(model),
           year=VALUES(year), color=VALUES(color)`,
        [driverId, dto.brand, dto.model, dto.year ?? null, dto.color ?? null, dto.plate_number],
      );
    });
    return {
      ok: true,
      message: 'Driver application submitted. An admin must approve it before you can take trips.',
    };
  }

  /** Admin dashboard login (email + password, NOT phone OTP). */
  async adminLogin(dto: AdminLoginDto) {
    const admin = await this.db.queryOne<{
      id: number; email: string; password_hash: string; name: string; role_id: number; status: string;
    }>('SELECT * FROM admin_users WHERE email = ?', [dto.email]);
    if (!admin || admin.status !== 'active') {
      throw new HttpException('Invalid email or password', HttpStatus.UNAUTHORIZED);
    }
    // The Phase 3 seed hash is PHP password_hash() ($2y$). bcryptjs speaks
    // $2a$/$2b$ — the algorithm is identical, so normalise the prefix.
    const hash = admin.password_hash.replace(/^\$2y\$/, '$2b$');
    const ok = await bcrypt.compare(dto.password, hash);
    if (!ok) throw new HttpException('Invalid email or password', HttpStatus.UNAUTHORIZED);
    const role = await this.db.queryOne<{ name: string }>(
      'SELECT name FROM admin_roles WHERE id = ?',
      [admin.role_id],
    );
    const token = this.signToken({
      sub: admin.id, email: admin.email, role: role?.name ?? 'admin', kind: 'admin',
    });
    await this.db.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [admin.id]);
    return {
      access_token: token,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: role?.name ?? 'admin' },
    };
  }

  async me(user: JwtPayload) {
    if (user.kind === 'admin') {
      const admin = await this.db.queryOne<{ id: number; email: string; name: string; status: string }>(
        'SELECT id, email, name, status FROM admin_users WHERE id = ?',
        [user.sub],
      );
      return { kind: 'admin', ...admin };
    }
    const row = await this.db.queryOne<{ id: number; phone: string; role: string; name: string; language: string; status: string }>(
      'SELECT id, phone, role, name, language, status FROM users WHERE id = ?',
      [user.sub],
    );
    return { kind: 'user', ...row };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('request-otp')
  @ApiOperation({ summary: 'Request a 6-digit OTP for a phone number (dev mode returns it)' })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto);
  }

  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify the OTP, returns a JWT' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @Post('register-passenger')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Complete the passenger profile (after OTP login)' })
  registerPassenger(@CurrentUser() user: JwtPayload, @Body() dto: RegisterPassengerDto) {
    return this.auth.registerPassenger(user, dto);
  }

  @Post('register-driver')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit the driver application (admin approval required)' })
  registerDriver(@CurrentUser() user: JwtPayload, @Body() dto: RegisterDriverDto) {
    return this.auth.registerDriver(user, dto);
  }

  @Post('admin-login')
  @ApiOperation({ summary: 'Admin dashboard login (email + password)' })
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user / admin profile from the JWT' })
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.me(user);
  }
}

@Module({
  imports: [
    DatabaseModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'change_this_to_a_long_random_secret'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') as any },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
