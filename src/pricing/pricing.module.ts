import { Injectable, Module, NotFoundException } from '@nestjs/common';
import { DatabaseService, DatabaseModule } from '../common/database';
import { round2 } from '../common/utils';

export interface PricingRow {
  id: number;
  base_fare: number;
  per_km: number;
  per_minute: number;
  minimum_fare: number;
  cancellation_fee: number;
  commission_percent: number;
  currency: string;
}

export interface FareBreakdown {
  base_fare: number;
  distance_km: number;
  distance_fare: number;
  duration_min: number;
  time_fare: number;
  total_fare: number;
  commission_percent: number;
  commission_amount: number;
  driver_amount: number;
  currency: string;
  pricing_config_id: number;
  minimum_applied: boolean;
}

/** Reads the ACTIVE pricing_config row and computes fares from it. */
@Injectable()
export class PricingService {
  constructor(private db: DatabaseService) {}

  async getActivePricing(): Promise<PricingRow> {
    const row = await this.db.queryOne<PricingRow>(
      'SELECT * FROM pricing_config WHERE is_active = 1 ORDER BY effective_from DESC LIMIT 1',
    );
    if (!row) throw new NotFoundException('No active pricing configuration');
    return row;
  }

  /** fare = base + per_km*km + per_minute*min, floored at minimum_fare. */
  calculate(pricing: PricingRow, distanceKm: number, durationMin: number): FareBreakdown {
    const distanceFare = round2(pricing.per_km * distanceKm);
    const timeFare = round2(pricing.per_minute * durationMin);
    let total = round2(Number(pricing.base_fare) + distanceFare + timeFare);
    const minimumApplied = total < Number(pricing.minimum_fare);
    if (minimumApplied) total = Number(pricing.minimum_fare);
    const commissionAmount = round2((total * Number(pricing.commission_percent)) / 100);
    return {
      base_fare: Number(pricing.base_fare),
      distance_km: round2(distanceKm),
      distance_fare: distanceFare,
      duration_min: durationMin,
      time_fare: timeFare,
      total_fare: total,
      commission_percent: Number(pricing.commission_percent),
      commission_amount: commissionAmount,
      driver_amount: round2(total - commissionAmount),
      currency: pricing.currency,
      pricing_config_id: pricing.id,
      minimum_applied: minimumApplied,
    };
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
