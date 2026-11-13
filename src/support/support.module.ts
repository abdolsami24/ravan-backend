import { Body, Controller, Get, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';

export class TicketDto {
  @IsString() subject!: string;
  @IsString() message!: string;
  @IsOptional() @IsNumber() trip_id?: number;
}

@Injectable()
export class SupportService {
  constructor(private db: DatabaseService) {}

  async create(user: JwtPayload, dto: TicketDto) {
    const res: any = await this.db.query(
      `INSERT INTO support_tickets (user_id, trip_id, subject, message, status)
       VALUES (?, ?, ?, ?, 'open')`,
      [user.sub, dto.trip_id ?? null, dto.subject, dto.message],
    );
    return { ok: true, ticket_id: res.insertId, status: 'open' };
  }

  async mine(user: JwtPayload) {
    return this.db.query(
      'SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [user.sub],
    );
  }
}

@ApiTags('support')
@Controller('support')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupportController {
  constructor(private support: SupportService) {}

  @Post('tickets')
  @Roles('passenger', 'driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open a support ticket / report an issue' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: TicketDto) {
    return this.support.create(user, dto);
  }

  @Get('tickets')
  @Roles('passenger', 'driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My support tickets' })
  mine(@CurrentUser() user: JwtPayload) {
    return this.support.mine(user);
  }
}

@Module({ imports: [DatabaseModule], providers: [SupportService], controllers: [SupportController] })
export class SupportModule {}
