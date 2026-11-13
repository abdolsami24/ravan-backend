/** Haversine distance in kilometres between two lat/lng points. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Rough city-motorcycle duration estimate: 30 km/h average in the city. */
export function estimateDurationMin(distanceKm: number): number {
  return Math.max(2, Math.round((distanceKm / 30) * 60));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 6-digit OTP as a string, e.g. "483920". */
export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
