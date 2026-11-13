import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';
import { haversineKm } from '../common/utils';
import { insertNotification } from '../common/notify';
import { TripsGateway, GatewayModule } from '../gateway/gateway.module';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
export class LocationDto {
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
}

export class OnlineDto {
  @IsEnum([0, 1]) online!: 0 | 1;
}

export class DocumentDto {
  @IsEnum(['license', 'id_card', 'vehicle_registration', 'photo'])
  document_type!: 'license' | 'id_card' | 'vehicle_registration' | 'photo';
  // Object-storage key, e.g. "drivers/4/license.jpg".
  // Real file upload to object storage is a later phase; the API records
  // the path only, exactly as the schema intends.
  @IsString() file_path!: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class DriversService {
  constructor(private db: DatabaseService, private gateway: TripsGateway) {}

  private async driverIdFor(userId: number) {
    const row = await this.db.queryOne<{ id: number; status: string }>(
      'SELECT id, status FROM drivers WHERE user_id = ?',
      [userId],
    );
    if (!row) throw new HttpException('Driver profile not found — register first', HttpStatus.NOT_FOUND);
    return row;
  }

  async profile(user: JwtPayload) {
    const driver = await this.driverIdFor(user.sub);
    const [profile] = await this.db.query(
      `SELECT d.*, u.name, u.phone, u.language,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', m.id, 'brand', m.brand, 'model', m.model,
                'year', m.year, 'color', m.color, 'plate_number', m.plate_number, 'is_active', m.is_active))
               FROM motorcycles m WHERE m.driver_id = d.id) AS motorcycles,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', dd.id, 'document_type', dd.document_type,
                'file_path', dd.file_path, 'status', dd.status))
               FROM driver_documents dd WHERE dd.driver_id = d.id) AS documents
       FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
      [driver.id],
    );
    return profile;
  }

  async setOnline(user: JwtPayload, dto: OnlineDto) {
    const driver = await this.driverIdFor(user.sub);
    if (dto.online === 1 && driver.status !== 'approved') {
      throw new HttpException(
        `Cannot go online: driver status is ${driver.status} (must be approved by an admin)`,
        HttpStatus.FORBIDDEN,
      );
    }
    await this.db.query('UPDATE drivers SET is_online = ? WHERE id = ?', [dto.online, driver.id]);
    return { ok: true, is_online: dto.online };
  }

  async updateLocation(user: JwtPayload, dto: LocationDto) {
    const driver = await this.driverIdFor(user.sub);
    await this.db.query(
      'UPDATE drivers SET current_lat = ?, current_lng = ?, location_updated_at = NOW() WHERE id = ?',
      [dto.lat, dto.lng, driver.id],
    );
    // Broadcast to any active trip room the driver belongs to.
    this.gateway.emitToDriver(driver.id, 'driver:location', { lat: dto.lat, lng: dto.lng });
    return { ok: true };
  }

  /** Pending requests near this driver (prototype: all pending, nearest first). */
  async incomingRequests(user: JwtPayload) {
    const driver = await this.driverIdFor(user.sub);
    const me = await this.db.queryOne<{ current_lat: number | null; current_lng: number | null }>(
      'SELECT current_lat, current_lng FROM drivers WHERE id = ?',
      [driver.id],
    );
    const rows = await this.db.query<{
      id: number; passenger_id: number; pickup_lat: number; pickup_lng: number;
      pickup_address: string | null; dropoff_lat: number; dropoff_lng: number;
      dropoff_address: string | null; estimated_fare: number; estimated_distance_km: number;
      estimated_duration_min: number; created_at: string; passenger_name: string;
    }>(
      `SELECT rr.*, u.name AS passenger_name
       FROM ride_requests rr
       JOIN passengers p ON p.id = rr.passenger_id
       JOIN users u ON u.id = p.user_id
       WHERE rr.status = 'pending' AND rr.expires_at > NOW()
       ORDER BY rr.created_at DESC LIMIT 20`,
    );
    return rows.map((r) => ({
      ...r,
      pickup_distance_km:
        me?.current_lat != null && me?.current_lng != null
          ? Math.round(haversineKm(me.current_lat, me.current_lng, r.pickup_lat, r.pickup_lng) * 100) / 100
          : null,
    }));
  }

  /**
   * Accept a request — ATOMIC: only one driver can win.
   * The conditional UPDATE only succeeds while the request is still
   * pending/matched; a second driver gets affectedRows = 0.
   */
  async acceptRequest(user: JwtPayload, requestId: number) {
    const driver = await this.driverIdFor(user.sub);
    if (driver.status !== 'approved') {
      throw new HttpException('Only approved drivers can accept requests', HttpStatus.FORBIDDEN);
    }
    const active = await this.db.queryOne<{ id: number }>(
      `SELECT t.id FROM trips t
       WHERE t.driver_id = ? AND t.status IN ('assigned', 'arrived', 'ongoing') LIMIT 1`,
      [driver.id],
    );
    if (active) {
      throw new HttpException('You already have an active trip — finish it first', HttpStatus.CONFLICT);
    }
    const bike = await this.db.queryOne<{ id: number }>(
      'SELECT id FROM motorcycles WHERE driver_id = ? AND is_active = 1 LIMIT 1',
      [driver.id],
    );
    if (!bike) throw new HttpException('No active motorcycle registered', HttpStatus.BAD_REQUEST);

    const result = await this.db.transaction(async (conn) => {
      const [res]: any = await conn.execute(
        `UPDATE ride_requests SET status = 'accepted', driver_id = ?
         WHERE id = ? AND status IN ('pending', 'matched')`,
        [driver.id, requestId],
      );
      if (res.affectedRows === 0) return null;
      await conn.execute(
        `UPDATE trips SET driver_id = ?, motorcycle_id = ?, status = 'assigned'
         WHERE ride_request_id = ? AND status = 'searching'`,
        [driver.id, bike.id, requestId],
      );
      const [trip]: any = await conn.execute(
        'SELECT id, passenger_id FROM trips WHERE ride_request_id = ?',
        [requestId],
      );
      return trip[0] as { id: number; passenger_id: number };
    });
    if (!result) {
      throw new HttpException('Request already taken or no longer available', HttpStatus.CONFLICT);
    }
    const passenger = await this.db.queryOne<{ user_id: number }>(
      'SELECT user_id FROM passengers WHERE id = ?',
      [result.passenger_id],
    );
    const driverName = await this.db.queryOne<{ name: string }>(
      'SELECT name FROM users WHERE id = ?',
      [user.sub],
    );
    if (passenger) {
      await insertNotification(
        this.db, passenger.user_id, 'driver_accepted',
        'Driver is on the way',
        `${driverName?.name ?? 'Your driver'} accepted your ride.`,
        { trip_id: result.id, ride_request_id: requestId },
      );
    }
    this.gateway.emitToTrip(result.id, 'trip:accepted', { trip_id: result.id, driver_id: driver.id });
    return { ok: true, trip_id: result.id, ride_request_id: requestId, status: 'assigned' };
  }

  async rejectRequest(user: JwtPayload, requestId: number) {
    const driver = await this.driverIdFor(user.sub);
    // Reject is recorded as an audit event; the request stays pending for
    // other drivers. We simply log it — no status change on the request.
    await this.db.query(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'driver.rejected_request', 'ride_request', ?, ?)`,
      [requestId, JSON.stringify({ driver_id: driver.id })],
    );
    return { ok: true, message: 'Request passed — it stays available for other drivers' };
  }

  async submitDocument(user: JwtPayload, dto: DocumentDto) {
    const driver = await this.driverIdFor(user.sub);
    await this.db.query(
      `INSERT INTO driver_documents (driver_id, document_type, file_path, status)
       VALUES (?, ?, ?, 'pending')`,
      [driver.id, dto.document_type, dto.file_path],
    );
    return { ok: true, message: 'Document submitted for admin review' };
  }

  async earnings(user: JwtPayload, period: string) {
    const driver = await this.driverIdFor(user.sub);
    const rows = await this.db.query<{
      day: string; trips: number; gross: number; commission: number; driver_amount: number;
    }>(
      `SELECT DATE(c.created_at) AS day, COUNT(*) AS trips,
              SUM(c.gross_amount) AS gross, SUM(c.commission_amount) AS commission,
              SUM(c.driver_amount) AS driver_amount
       FROM commissions c JOIN trips t ON t.id = c.trip_id
       WHERE c.driver_id = ? AND t.status = 'completed'
       GROUP BY DATE(c.created_at) ORDER BY day DESC LIMIT 31`,
      [driver.id],
    );
    const totals = rows.reduce(
      (acc, r) => ({
        trips: acc.trips + Number(r.trips),
        gross: acc.gross + Number(r.gross),
        commission: acc.commission + Number(r.commission),
        driver_amount: acc.driver_amount + Number(r.driver_amount),
      }),
      { trips: 0, gross: 0, commission: 0, driver_amount: 0 },
    );
    const monthly = period === 'monthly'
      ? await this.db.query<{ month: string; trips: number; driver_amount: number }>(
          `SELECT DATE_FORMAT(c.created_at, '%Y-%m') AS month, COUNT(*) AS trips,
                  SUM(c.driver_amount) AS driver_amount
           FROM commissions c JOIN trips t ON t.id = c.trip_id
           WHERE c.driver_id = ? AND t.status = 'completed'
           GROUP BY DATE_FORMAT(c.created_at, '%Y-%m') ORDER BY month DESC LIMIT 12`,
          [driver.id],
        )
      : [];
    return { driver_id: driver.id, period, totals, daily: rows, monthly };
  }

  async myTrips(user: JwtPayload) {
    const driver = await this.driverIdFor(user.sub);
    return this.db.query(
      `SELECT t.*, rr.pickup_address, rr.dropoff_address, u.name AS passenger_name
       FROM trips t
       JOIN ride_requests rr ON rr.id = t.ride_request_id
       JOIN passengers p ON p.id = t.passenger_id
       JOIN users u ON u.id = p.user_id
       WHERE t.driver_id = ? ORDER BY t.created_at DESC LIMIT 50`,
      [driver.id],
    );
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@ApiTags('drivers')
@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriversController {
  constructor(private drivers: DriversService) {}

  @Get('me')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My driver profile, motorcycles and documents' })
  profile(@CurrentUser() user: JwtPayload) {
    return this.drivers.profile(user);
  }

  @Post('online')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Go online (1) or offline (0) — approved drivers only' })
  setOnline(@CurrentUser() user: JwtPayload, @Body() dto: OnlineDto) {
    return this.drivers.setOnline(user, dto);
  }

  @Post('location')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update my current GPS location' })
  location(@CurrentUser() user: JwtPayload, @Body() dto: LocationDto) {
    return this.drivers.updateLocation(user, dto);
  }

  @Get('requests')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Pending ride requests near me' })
  incoming(@CurrentUser() user: JwtPayload) {
    return this.drivers.incomingRequests(user);
  }

  @Post('requests/:id/accept')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Accept a ride request (atomic — only one driver wins)' })
  accept(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.drivers.acceptRequest(user, Number(id));
  }

  @Post('requests/:id/reject')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Pass on a ride request' })
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.drivers.rejectRequest(user, Number(id));
  }

  @Post('documents')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a document (records the object-storage path)' })
  document(@CurrentUser() user: JwtPayload, @Body() dto: DocumentDto) {
    return this.drivers.submitDocument(user, dto);
  }

  @Get('earnings')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My earnings: totals, daily breakdown, optional monthly' })
  earnings(@CurrentUser() user: JwtPayload, @Query('period') period = 'daily') {
    return this.drivers.earnings(user, period);
  }

  @Get('trips')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My trip history' })
  trips(@CurrentUser() user: JwtPayload) {
    return this.drivers.myTrips(user);
  }
}

@Module({
  imports: [DatabaseModule, GatewayModule],
  providers: [DriversService],
  controllers: [DriversController],
  exports: [DriversService],
})
export class DriversModule {}
