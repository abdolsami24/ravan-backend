import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';

export class PricingUpdateDto {
  @IsNumber() base_fare!: number;
  @IsNumber() per_km!: number;
  @IsNumber() per_minute!: number;
  @IsNumber() minimum_fare!: number;
  @IsNumber() cancellation_fee!: number;
  @IsNumber() commission_percent!: number;
}

export class TicketReplyDto {
  @IsString() reply!: string;
  @IsOptional() @IsString() status?: string;
}

@Injectable()
export class AdminService {
  constructor(private db: DatabaseService) {}

  private async audit(adminId: number | null, action: string, entityType: string, entityId: number, details: any, ip?: string) {
    await this.db.query(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adminId, action, entityType, entityId, JSON.stringify(details), ip ?? null],
    );
  }

  async stats() {
    const one = async (sql: string, params: any[] = []) => {
      const row = await this.db.queryOne<{ c: number }>(sql, params);
      return row?.c ?? 0;
    };
    const revenue = await this.db.queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(c.gross_amount), 0) AS total
       FROM commissions c JOIN trips t ON t.id = c.trip_id WHERE t.status = 'completed'`,
    );
    const commission = await this.db.queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(c.commission_amount), 0) AS total
       FROM commissions c JOIN trips t ON t.id = c.trip_id WHERE t.status = 'completed'`,
    );
    return {
      total_passengers: await one(`SELECT COUNT(*) c FROM users WHERE role = 'passenger'`),
      total_drivers: await one(`SELECT COUNT(*) c FROM drivers`),
      approved_drivers: await one(`SELECT COUNT(*) c FROM drivers WHERE status = 'approved'`),
      pending_drivers: await one(`SELECT COUNT(*) c FROM drivers WHERE status = 'pending'`),
      active_drivers_online: await one(`SELECT COUNT(*) c FROM drivers WHERE status = 'approved' AND is_online = 1`),
      total_trips: await one(`SELECT COUNT(*) c FROM trips`),
      completed_trips: await one(`SELECT COUNT(*) c FROM trips WHERE status = 'completed'`),
      cancelled_trips: await one(`SELECT COUNT(*) c FROM trips WHERE status = 'cancelled'`),
      open_tickets: await one(`SELECT COUNT(*) c FROM support_tickets WHERE status = 'open'`),
      gross_revenue_afn: Number(revenue?.total ?? 0),
      platform_commission_afn: Number(commission?.total ?? 0),
    };
  }

  async listDrivers(status?: string) {
    const where = status ? 'WHERE d.status = ?' : '';
    const params = status ? [status] : [];
    return this.db.query(
      `SELECT d.*, u.name, u.phone, u.language, u.status AS user_status,
              (SELECT COUNT(*) FROM driver_documents dd WHERE dd.driver_id = d.id AND dd.status = 'pending') AS pending_documents
       FROM drivers d JOIN users u ON u.id = d.user_id ${where} ORDER BY d.created_at DESC`,
      params,
    );
  }

  private async setDriverStatus(admin: JwtPayload, driverId: number, status: 'approved' | 'rejected' | 'suspended') {
    const driver = await this.db.queryOne<{ id: number; user_id: number }>(
      'SELECT id, user_id FROM drivers WHERE id = ?',
      [driverId],
    );
    if (!driver) throw new HttpException('Driver not found', HttpStatus.NOT_FOUND);
    await this.db.query(
      `UPDATE drivers SET status = ?, approved_by = ?, approved_at = ?
       WHERE id = ?`,
      [status, status === 'approved' ? admin.sub : null, status === 'approved' ? new Date() : null, driverId],
    );
    await this.audit(admin.sub, `driver.${status}`, 'driver', driverId, { driver_id: driverId });
    return { ok: true, driver_id: driverId, status };
  }

  approve(admin: JwtPayload, id: number) { return this.setDriverStatus(admin, id, 'approved'); }
  reject(admin: JwtPayload, id: number) { return this.setDriverStatus(admin, id, 'rejected'); }
  suspend(admin: JwtPayload, id: number) { return this.setDriverStatus(admin, id, 'suspended'); }

  async listTrips(status?: string, limit = 50) {
    const where = status ? 'WHERE t.status = ?' : '';
    const params: any[] = status ? [status] : [];
    return this.db.query(
      `SELECT t.*, rr.pickup_address, rr.dropoff_address, fr.total_fare, fr.currency,
              pu.name AS passenger_name, du.name AS driver_name
       FROM trips t
       JOIN ride_requests rr ON rr.id = t.ride_request_id
       LEFT JOIN fare_records fr ON fr.trip_id = t.id
       JOIN passengers p ON p.id = t.passenger_id JOIN users pu ON pu.id = p.user_id
       LEFT JOIN drivers d ON d.id = t.driver_id LEFT JOIN users du ON du.id = d.user_id
       ${where} ORDER BY t.created_at DESC LIMIT ${Math.min(limit, 200)}`,
      params,
    );
  }

  async getPricing() {
    return this.db.query(
      'SELECT * FROM pricing_config ORDER BY effective_from DESC LIMIT 5',
    );
  }

  /** Versioned pricing update: close the active row, insert a new one. */
  async updatePricing(admin: JwtPayload, dto: PricingUpdateDto) {
    const res: any = await this.db.transaction(async (conn) => {
      await conn.execute(
        `UPDATE pricing_config SET is_active = 0, effective_to = NOW() WHERE is_active = 1`,
      );
      const [r]: any = await conn.execute(
        `INSERT INTO pricing_config
           (base_fare, per_km, per_minute, minimum_fare, cancellation_fee, commission_percent, currency, is_active, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'AFN', 1, ?)`,
        [dto.base_fare, dto.per_km, dto.per_minute, dto.minimum_fare, dto.cancellation_fee, dto.commission_percent, admin.sub],
      );
      return r.insertId;
    });
    await this.audit(admin.sub, 'pricing.updated', 'pricing_config', res, dto);
    return { ok: true, pricing_config_id: res, ...dto };
  }

  async listTickets(status?: string) {
    const where = status ? 'WHERE st.status = ?' : '';
    const params = status ? [status] : [];
    return this.db.query(
      `SELECT st.*, u.name AS user_name, u.phone FROM support_tickets st
       JOIN users u ON u.id = st.user_id ${where} ORDER BY st.created_at DESC LIMIT 100`,
      params,
    );
  }

  async replyTicket(admin: JwtPayload, ticketId: number, dto: TicketReplyDto) {
    const res: any = await this.db.query(
      `UPDATE support_tickets SET admin_reply = ?, status = ? WHERE id = ?`,
      [dto.reply, dto.status ?? 'in_progress', ticketId],
    );
    if (res.affectedRows === 0) throw new HttpException('Ticket not found', HttpStatus.NOT_FOUND);
    await this.audit(admin.sub, 'support.replied', 'support_ticket', ticketId, { reply: dto.reply });
    return { ok: true, ticket_id: ticketId };
  }

  async auditLogs(limit = 100) {
    return this.db.query(
      `SELECT al.*, au.name AS admin_name FROM audit_logs al
       LEFT JOIN admin_users au ON au.id = al.admin_user_id
       ORDER BY al.created_at DESC LIMIT ${Math.min(limit, 200)}`,
    );
  }

  async listPassengers() {
    return this.db.query(
      `SELECT u.id, u.phone, u.name, u.language, u.status, u.created_at,
              (SELECT COUNT(*) FROM trips t JOIN passengers p ON p.id = t.passenger_id WHERE p.user_id = u.id) AS trips
       FROM users u WHERE u.role = 'passenger' ORDER BY u.created_at DESC LIMIT 100`,
    );
  }
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('stats')
  @Roles('admin', 'super_admin', 'support')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dashboard counts: passengers, drivers, trips, revenue' })
  stats() { return this.admin.stats(); }

  @Get('passengers')
  @Roles('admin', 'super_admin', 'support')
  @ApiBearerAuth()
  passengers() { return this.admin.listPassengers(); }

  @Get('drivers')
  @Roles('admin', 'super_admin', 'support')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'All drivers, optional ?status=pending|approved|...' })
  drivers(@Query('status') status?: string) { return this.admin.listDrivers(status); }

  @Post('drivers/:id/approve')
  @Roles('admin', 'super_admin')
  @ApiBearerAuth()
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.admin.approve(user, Number(id));
  }

  @Post('drivers/:id/reject')
  @Roles('admin', 'super_admin')
  @ApiBearerAuth()
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.admin.reject(user, Number(id));
  }

  @Post('drivers/:id/suspend')
  @Roles('admin', 'super_admin')
  @ApiBearerAuth()
  suspend(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.admin.suspend(user, Number(id));
  }

  @Get('trips')
  @Roles('admin', 'super_admin', 'support')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'All trips, optional ?status=' })
  trips(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.admin.listTrips(status, limit ? Number(limit) : 50);
  }

  @Get('pricing')
  @Roles('admin', 'super_admin')
  @ApiBearerAuth()
  pricing() { return this.admin.getPricing(); }

  @Put('pricing')
  @Roles('admin', 'super_admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new versioned pricing row (old one is closed)' })
  updatePricing(@CurrentUser() user: JwtPayload, @Body() dto: PricingUpdateDto) {
    return this.admin.updatePricing(user, dto);
  }

  @Get('tickets')
  @Roles('admin', 'super_admin', 'support')
  @ApiBearerAuth()
  tickets(@Query('status') status?: string) { return this.admin.listTickets(status); }

  @Post('tickets/:id/reply')
  @Roles('admin', 'super_admin', 'support')
  @ApiBearerAuth()
  reply(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: TicketReplyDto) {
    return this.admin.replyTicket(user, Number(id), dto);
  }

  @Get('audit-logs')
  @Roles('admin', 'super_admin')
  @ApiBearerAuth()
  auditLogs(@Query('limit') limit?: string) {
    return this.admin.auditLogs(limit ? Number(limit) : 100);
  }
}

@Module({ imports: [DatabaseModule], providers: [AdminService], controllers: [AdminController] })
export class AdminModule {}
