import { Body, Controller, HttpException, HttpStatus, Injectable, Module, Param, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard, RolesGuard, Roles } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';

export class RateDto {
  @IsInt() @Min(1) @Max(5) stars!: number;
  @IsOptional() @IsString() comment?: string;
}

@Injectable()
export class RatingsService {
  constructor(private db: DatabaseService) {}

  async rateTrip(user: JwtPayload, tripId: number, dto: RateDto) {
    const trip = await this.db.queryOne<any>('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip) throw new HttpException('Trip not found', HttpStatus.NOT_FOUND);
    if (trip.status !== 'completed') {
      throw new HttpException('Only completed trips can be rated', HttpStatus.BAD_REQUEST);
    }
    const passenger = await this.db.queryOne<{ user_id: number }>(
      'SELECT user_id FROM passengers WHERE id = ?', [trip.passenger_id],
    );
    const driver = trip.driver_id
      ? await this.db.queryOne<{ user_id: number }>('SELECT user_id FROM drivers WHERE id = ?', [trip.driver_id])
      : null;
    let rateeId: number;
    let role: 'passenger' | 'driver';
    if (user.role === 'passenger' && passenger?.user_id === user.sub) {
      if (!driver) throw new HttpException('No driver on this trip', HttpStatus.BAD_REQUEST);
      rateeId = driver.user_id; role = 'passenger';
    } else if (user.role === 'driver' && driver?.user_id === user.sub) {
      rateeId = passenger!.user_id; role = 'driver';
    } else {
      throw new HttpException('Not your trip', HttpStatus.FORBIDDEN);
    }
    await this.db.query(
      `INSERT INTO ratings (trip_id, rater_id, ratee_id, role, stars, comment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stars=VALUES(stars), comment=VALUES(comment)`,
      [tripId, user.sub, rateeId, role, dto.stars, dto.comment ?? null],
    );
    // Recompute the driver's average rating (passenger ratings only).
    if (role === 'passenger' && trip.driver_id) {
      await this.db.query(
        `UPDATE drivers SET rating_avg = (
           SELECT COALESCE(AVG(stars), 0) FROM ratings r
           JOIN drivers d2 ON d2.user_id = r.ratee_id
           WHERE d2.id = ? AND r.role = 'passenger'
         ) WHERE id = ?`,
        [trip.driver_id, trip.driver_id],
      );
    }
    return { ok: true, trip_id: tripId, stars: dto.stars };
  }
}

@ApiTags('ratings')
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RatingsController {
  constructor(private ratings: RatingsService) {}

  @Post(':id/rate')
  @Roles('passenger', 'driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rate the other party after a completed trip (1-5 stars)' })
  rate(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RateDto) {
    return this.ratings.rateTrip(user, Number(id), dto);
  }
}

@Module({ imports: [DatabaseModule], providers: [RatingsService], controllers: [RatingsController] })
export class RatingsModule {}
