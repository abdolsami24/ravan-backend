import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './common/database';
import { AuthModule } from './auth/auth.module';
import { PricingModule } from './pricing/pricing.module';
import { RidesModule } from './rides/rides.module';
import { DriversModule } from './drivers/drivers.module';
import { TripsModule } from './trips/trips.module';
import { RatingsModule } from './ratings/ratings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SupportModule } from './support/support.module';
import { AdminModule } from './admin/admin.module';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DatabaseModule,
    AuthModule,
    PricingModule,
    RidesModule,
    DriversModule,
    TripsModule,
    RatingsModule,
    NotificationsModule,
    SupportModule,
    AdminModule,
    GatewayModule,
  ],
})
export class AppModule {}
