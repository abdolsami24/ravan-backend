import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, Param, Post, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';
import { PricingService, PricingModule } from '../pricing/pricing.module';
import { haversineKm, round2 } from '../common/utils';
import { insertNotification } from '../common/notify';
import { TripsGateway, GatewayModule } from '../gateway/gateway.module';

export class ConfirmPaymentDto {
  @IsOptional() @IsString() note?: string;
}

@Injectable()
export class TripsService {
  constructor(
    private db: DatabaseService,
    private pricing: PricingService,
    private gateway: TripsGateway,
  ) {}

  private async loadTrip(id: number) {
    const trip = await this.db.queryOne<any>('SELECT * FROM trips WHERE id = ?', [id]);
    if (!trip) throw new HttpException('Trip not found', HttpStatus.NOT_FOUND);
    return trip;
  }

  /** Caller must be the trip's passenger or driver. */
  private async authorize(user: JwtPayload, trip: any): Promise<'passenger' | 'driver'> {
    if (user.kind === 'admin') return 'passenger'; // admins read via /admin
    const passenger = await this.db.queryOne<{ user_id: number }>(
      'SELECT user_id FROM passengers WHERE id = ?',
      [trip.passenger_id],
    );
    if (passenger?.user_id === user.sub) return 'passenger';
    if (trip.driver_id) {
      const driver = await this.db.queryOne<{ user_id: number }>(
        'SELECT user_id FROM drivers WHERE id = ?',
        [trip.driver_id],
      );
      if (driver?.user_id === user.sub) return 'driver';
    }
    throw new HttpException('Not your trip', HttpStatus.FORBIDDEN);
  }

  async getTrip(user: JwtPayload, id: number) {
    const trip = await this.loadTrip(id);
    await this.authorize(user, trip);
    const [detail] = await this.db.query(
      `SELECT t.*, rr.pickup_address, rr.dropoff_address, rr.estimated_fare,
              fr.total_fare, fr.base_fare, fr.distance_km, fr.distance_fare,
              fr.duration_min, fr.time_fare, fr.currency,
              p.user_id AS passenger_user_id, pu.name AS passenger_name,
              d.user_id AS driver_user_id, du.name AS driver_name, du.phone AS driver_phone,
              m.brand AS bike_brand, m.model AS bike_model, m.plate_number
       FROM trips t
       JOIN ride_requests rr ON rr.id = t.ride_request_id
       LEFT JOIN fare_records fr ON fr.trip_id = t.id
       JOIN passengers p ON p.id = t.passenger_id
       JOIN users pu ON pu.id = p.user_id
       LEFT JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN users du ON du.id = d.user_id
       LEFT JOIN motorcycles m ON m.id = t.motorcycle_id
       WHERE t.id = ?`,
      [id],
    );
    // Privacy: hide the driver's phone from anyone who is not the passenger
    // or the driver of this trip (already enforced by authorize()).
    return detail;
  }

  async passengerTrips(user: JwtPayload) {
    const passenger = await this.db.queryOne<{ id: number }>(
      'SELECT id FROM passengers WHERE user_id = ?',
      [user.sub],
    );
    if (!passenger) return [];
    return this.db.query(
      `SELECT t.*, rr.pickup_address, rr.dropoff_address, fr.total_fare, fr.currency
       FROM trips t JOIN ride_requests rr ON rr.id = t.ride_request_id
       LEFT JOIN fare_records fr ON fr.trip_id = t.id
       WHERE t.passenger_id = ? ORDER BY t.created_at DESC LIMIT 50`,
      [passenger.id],
    );
  }

  private async transition(user: JwtPayload, id: number, from: string[], to: string, extra: Record<string, any> = {}) {
    const trip = await this.loadTrip(id);
    const who = await this.authorize(user, trip);
    if (who !== 'driver') {
      throw new HttpException('Only the driver changes trip status', HttpStatus.FORBIDDEN);
    }
    if (!from.includes(trip.status)) {
      throw new HttpException(`Cannot move a ${trip.status} trip to ${to}`, HttpStatus.BAD_REQUEST);
    }
    const sets = [`status = '${to}'`];
    const params: any[] = [];
    if (to === 'arrived' || to === 'ongoing') {
      if (to === 'ongoing') sets.push('started_at = NOW()');
    }
    if (to === 'completed') sets.push('completed_at = NOW()');
    await this.db.query(`UPDATE trips SET ${sets.join(', ')} WHERE id = ?`, [id]);
    return { trip, who };
  }

  async arrived(user: JwtPayload, id: number) {
    const { trip } = await this.transition(user, id, ['assigned'], 'arrived');
    await this.notifyPassenger(trip, 'driver_arrived', 'Driver arrived', 'Your driver has arrived at the pickup point.', 'trip:arrived');
    return { ok: true, status: 'arrived' };
  }

  async start(user: JwtPayload, id: number) {
    const { trip } = await this.transition(user, id, ['arrived'], 'ongoing');
    await this.notifyPassenger(trip, 'trip_started', 'Trip started', 'Your trip is under way.', 'trip:started');
    return { ok: true, status: 'ongoing' };
  }

  async complete(user: JwtPayload, id: number) {
    const { trip } = await this.transition(user, id, ['ongoing'], 'completed');
    // Final fare: use the estimated route distance/duration recorded on the
    // request, plus real duration from started_at to now.
    const req = await this.db.queryOne<{
      estimated_distance_km: number; estimated_duration_min: number;
    }>('SELECT estimated_distance_km, estimated_duration_min FROM ride_requests WHERE id = ?', [trip.ride_request_id]);
    const durationMin = trip.started_at
      ? Math.max(1, Math.round((Date.now() - new Date(trip.started_at).getTime()) / 60000))
      : (req?.estimated_duration_min ?? 0);
    const cfg = await this.pricing.getActivePricing();
    const fare = this.pricing.calculate(cfg, Number(req?.estimated_distance_km ?? 0), durationMin);

    await this.db.transaction(async (conn) => {
      await conn.execute(
        `INSERT INTO fare_records
           (trip_id, base_fare, distance_km, distance_fare, duration_min, time_fare, total_fare, currency, pricing_config_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE total_fare=VALUES(total_fare)`,
        [id, fare.base_fare, fare.distance_km, fare.distance_fare, fare.duration_min,
         fare.time_fare, fare.total_fare, fare.currency, fare.pricing_config_id],
      );
      const passengerUser = await conn.execute(
        'SELECT user_id FROM passengers WHERE id = ?', [trip.passenger_id],
      );
      const payerId = (passengerUser[0] as any[])[0]?.user_id;
      await conn.execute(
        `INSERT INTO payments (trip_id, payer_id, method, amount, currency, status)
         VALUES (?, ?, 'cash', ?, ?, 'pending')`,
        [id, payerId, fare.total_fare, fare.currency],
      );
      await conn.execute(
        `INSERT INTO commissions (trip_id, driver_id, gross_amount, commission_percent, commission_amount, driver_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [id, trip.driver_id, fare.total_fare, fare.commission_percent, fare.commission_amount, fare.driver_amount],
      );
      await conn.execute('UPDATE drivers SET total_trips = total_trips + 1 WHERE id = ?', [trip.driver_id]);
    });
    await this.notifyPassenger(trip, 'trip_completed', 'Trip completed',
      `Your trip is complete. Fare: ${fare.total_fare} ${fare.currency} (cash).`, 'trip:completed');
    const driverUser = await this.db.queryOne<{ user_id: number }>(
      'SELECT user_id FROM drivers WHERE id = ?', [trip.driver_id],
    );
    if (driverUser) {
      await insertNotification(this.db, driverUser.user_id, 'trip_completed', 'Trip completed',
        `You completed a trip. You earned ${fare.driver_amount} ${fare.currency}.`, { trip_id: id });
    }
    return { ok: true, status: 'completed', fare };
  }

  async confirmPayment(user: JwtPayload, id: number) {
    const trip = await this.loadTrip(id);
    const who = await this.authorize(user, trip);
    if (who !== 'driver') throw new HttpException('Only the driver confirms cash payment', HttpStatus.FORBIDDEN);
    if (trip.status !== 'completed') {
      throw new HttpException('Trip must be completed first', HttpStatus.BAD_REQUEST);
    }
    const res: any = await this.db.query(
      `UPDATE payments SET status = 'paid', paid_at = NOW() WHERE trip_id = ? AND status = 'pending'`,
      [id],
    );
    return { ok: true, payment_marked_paid: res.affectedRows > 0 };
  }

  private async notifyPassenger(trip: any, type: string, title: string, body: string, event: string) {
    const passenger = await this.db.queryOne<{ user_id: number }>(
      'SELECT user_id FROM passengers WHERE id = ?',
      [trip.passenger_id],
    );
    if (passenger) {
      await insertNotification(this.db, passenger.user_id, type, title, body, { trip_id: trip.id });
    }
    this.gateway.emitToTrip(trip.id, event, { trip_id: trip.id, status: trip.status });
  }
}

@ApiTags('trips')
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripsController {
  constructor(private trips: TripsService) {}

  @Get('mine')
  @Roles('passenger')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My trips as a passenger' })
  mine(@CurrentUser() user: JwtPayload) {
    return this.trips.passengerTrips(user);
  }

  @Get(':id')
  @Roles('passenger', 'driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trip detail with fare and driver/passenger info' })
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.trips.getTrip(user, Number(id));
  }

  @Post(':id/arrived')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Driver: I arrived at the pickup point' })
  arrived(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.trips.arrived(user, Number(id));
  }

  @Post(':id/start')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Driver: passenger picked up, trip starts' })
  start(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.trips.start(user, Number(id));
  }

  @Post(':id/complete')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Driver: trip complete — creates fare, cash payment and commission' })
  complete(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.trips.complete(user, Number(id));
  }

  @Post(':id/confirm-payment')
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Driver: confirm the cash payment was received' })
  confirmPayment(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.trips.confirmPayment(user, Number(id));
  }
}

@Module({
  imports: [DatabaseModule, PricingModule, GatewayModule],
  providers: [TripsService],
  controllers: [TripsController],
  exports: [TripsService],
})
export class TripsModule {}
