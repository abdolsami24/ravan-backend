import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';
import { PricingService, PricingModule } from '../pricing/pricing.module';
import { estimateDurationMin, haversineKm } from '../common/utils';
import { insertNotification } from '../common/notify';
import { TripsGateway, GatewayModule } from '../gateway/gateway.module';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
export class EstimateDto {
  @IsNumber() pickup_lat!: number;
  @IsNumber() pickup_lng!: number;
  @IsNumber() dropoff_lat!: number;
  @IsNumber() dropoff_lng!: number;
}

export class RideRequestDto extends EstimateDto {
  @IsOptional() @IsString() pickup_address?: string;
  @IsOptional() @IsString() dropoff_address?: string;
}

export class CancelDto {
  @IsOptional() @IsString() reason?: string;
}

// ---------------------------------------------------------------------------
// Matching service — nearest approved + online drivers
// ---------------------------------------------------------------------------
@Injectable()
export class MatchingService {
  constructor(private db: DatabaseService) {}

  /**
   * Find approved, online drivers near the pickup point, nearest first.
   * Prototype: plain distance sort on current_lat/current_lng. Real
   * geo-indexing (MySQL spatial index / PostGIS-style) comes in a later phase.
   */
  async findNearbyDrivers(pickupLat: number, pickupLng: number, limit = 5) {
    const drivers = await this.db.query<{
      id: number; user_id: number; name: string; phone: string;
      rating_avg: number; total_trips: number; current_lat: number; current_lng: number;
    }>(
      `SELECT d.id, d.user_id, u.name, u.phone, d.rating_avg, d.total_trips,
              d.current_lat, d.current_lng
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.status = 'approved' AND d.is_online = 1
         AND d.current_lat IS NOT NULL AND d.current_lng IS NOT NULL
         AND u.status = 'active'`,
    );
    return drivers
      .map((d) => ({
        ...d,
        distance_km: Math.round(haversineKm(pickupLat, pickupLng, d.current_lat, d.current_lng) * 100) / 100,
      }))
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class RidesService {
  constructor(
    private db: DatabaseService,
    private pricing: PricingService,
    private matching: MatchingService,
    private gateway: TripsGateway,
  ) {}

  async estimate(dto: EstimateDto) {
    const cfg = await this.pricing.getActivePricing();
    const distanceKm = haversineKm(dto.pickup_lat, dto.pickup_lng, dto.dropoff_lat, dto.dropoff_lng);
    const durationMin = estimateDurationMin(distanceKm);
    const fare = this.pricing.calculate(cfg, distanceKm, durationMin);
    const nearby = await this.matching.findNearbyDrivers(dto.pickup_lat, dto.pickup_lng, 5);
    return { ...fare, drivers_nearby: nearby.length, nearest_driver_km: nearby[0]?.distance_km ?? null };
  }

  private async passengerIdFor(userId: number): Promise<number> {
    const row = await this.db.queryOne<{ id: number }>(
      'SELECT id FROM passengers WHERE user_id = ?',
      [userId],
    );
    if (!row) {
      // Auto-create the passenger profile on first ride (profile can be
      // completed later via /auth/register-passenger).
      const res: any = await this.db.query(
        'INSERT INTO passengers (user_id) VALUES (?)',
        [userId],
      );
      return res.insertId;
    }
    return row.id;
  }

  async requestRide(user: JwtPayload, dto: RideRequestDto) {
    const passengerId = await this.passengerIdFor(user.sub);
    const cfg = await this.pricing.getActivePricing();
    const distanceKm = haversineKm(dto.pickup_lat, dto.pickup_lng, dto.dropoff_lat, dto.dropoff_lng);
    const durationMin = estimateDurationMin(distanceKm);
    const fare = this.pricing.calculate(cfg, distanceKm, durationMin);
    const nearby = await this.matching.findNearbyDrivers(dto.pickup_lat, dto.pickup_lng, 5);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    const result = await this.db.transaction(async (conn) => {
      const [req]: any = await conn.execute(
        `INSERT INTO ride_requests
           (passenger_id, pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
            status, estimated_fare, estimated_distance_km, estimated_duration_min, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        [passengerId, dto.pickup_lat, dto.pickup_lng, dto.pickup_address ?? null,
         dto.dropoff_lat, dto.dropoff_lng, dto.dropoff_address ?? null,
         fare.total_fare, fare.distance_km, fare.duration_min, expiresAt],
      );
      const requestId = req.insertId;
      const [trip]: any = await conn.execute(
        `INSERT INTO trips (ride_request_id, passenger_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng)
         VALUES (?, ?, 'searching', ?, ?, ?, ?)`,
        [requestId, passengerId, dto.pickup_lat, dto.pickup_lng, dto.dropoff_lat, dto.dropoff_lng],
      );
      return { requestId, tripId: trip.insertId };
    });

    // Notify the matched drivers (in-app) and push the request over WS.
    for (const d of nearby) {
      await insertNotification(
        this.db, d.user_id, 'ride_request',
        'New ride request',
        `Pickup: ${dto.pickup_address ?? 'map pin'} — fare about ${fare.total_fare} ${fare.currency}.`,
        { ride_request_id: result.requestId, trip_id: result.tripId },
      );
      this.gateway.emitToDriver(d.id, 'ride:request', {
        ride_request_id: result.requestId,
        trip_id: result.tripId,
        pickup_lat: dto.pickup_lat, pickup_lng: dto.pickup_lng,
        pickup_address: dto.pickup_address ?? null,
        dropoff_lat: dto.dropoff_lat, dropoff_lng: dto.dropoff_lng,
        dropoff_address: dto.dropoff_address ?? null,
        estimated_fare: fare.total_fare, currency: fare.currency,
      });
    }
    return {
      ride_request_id: result.requestId,
      trip_id: result.tripId,
      status: 'pending',
      estimated_fare: fare,
      drivers_notified: nearby.map((d) => ({ driver_id: d.id, name: d.name, distance_km: d.distance_km })),
    };
  }

  async cancelRequest(user: JwtPayload, requestId: number, dto: CancelDto) {
    const req = await this.db.queryOne<{
      id: number; passenger_id: number; status: string; driver_id: number | null;
    }>('SELECT * FROM ride_requests WHERE id = ?', [requestId]);
    if (!req) throw new HttpException('Ride request not found', HttpStatus.NOT_FOUND);
    const passenger = await this.db.queryOne<{ id: number; user_id: number }>(
      'SELECT id, user_id FROM passengers WHERE id = ?',
      [req.passenger_id],
    );
    if (!passenger || passenger.user_id !== user.sub) {
      throw new HttpException('Not your ride request', HttpStatus.FORBIDDEN);
    }
    if (!['pending', 'matched', 'accepted'].includes(req.status)) {
      throw new HttpException(`Cannot cancel a ${req.status} request`, HttpStatus.BAD_REQUEST);
    }
    await this.db.transaction(async (conn) => {
      await conn.execute(
        `UPDATE ride_requests SET status = 'cancelled', cancelled_by = 'passenger', cancel_reason = ? WHERE id = ?`,
        [dto.reason ?? null, requestId],
      );
      await conn.execute(
        `UPDATE trips SET status = 'cancelled', cancelled_at = NOW() WHERE ride_request_id = ?`,
        [requestId],
      );
    });
    return { ok: true, status: 'cancelled' };
  }

  async myRequests(user: JwtPayload) {
    const passenger = await this.db.queryOne<{ id: number }>(
      'SELECT id FROM passengers WHERE user_id = ?',
      [user.sub],
    );
    if (!passenger) return [];
    return this.db.query(
      `SELECT rr.*, t.id AS trip_id, t.status AS trip_status
       FROM ride_requests rr LEFT JOIN trips t ON t.ride_request_id = rr.id
       WHERE rr.passenger_id = ? ORDER BY rr.created_at DESC LIMIT 50`,
      [passenger.id],
    );
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@ApiTags('rides')
@Controller('rides')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RidesController {
  constructor(private rides: RidesService) {}

  @Post('estimate')
  @Roles('passenger', 'driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fare estimate for pickup → dropoff (uses active pricing_config)' })
  estimate(@Body() dto: EstimateDto) {
    return this.rides.estimate(dto);
  }

  @Post('request')
  @Roles('passenger')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a ride request; notifies nearby approved online drivers' })
  request(@CurrentUser() user: JwtPayload, @Body() dto: RideRequestDto) {
    return this.rides.requestRide(user, dto);
  }

  @Post(':id/cancel')
  @Roles('passenger')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Passenger cancels a pending/matched/accepted request' })
  cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: CancelDto) {
    return this.rides.cancelRequest(user, Number(id), dto);
  }

  @Get('mine')
  @Roles('passenger')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My ride requests with their trip status' })
  mine(@CurrentUser() user: JwtPayload) {
    return this.rides.myRequests(user);
  }
}

@Module({
  imports: [DatabaseModule, PricingModule, GatewayModule],
  providers: [MatchingService, RidesService],
  controllers: [RidesController],
  exports: [MatchingService, RidesService],
})
export class RidesModule {}
