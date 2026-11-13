import { Injectable, Module } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * Socket.IO gateway: one room per trip (trip_<id>) and one per driver
 * (driver_<id>). Clients must send their JWT in the auth payload; the
 * prototype trusts the client-supplied ids for room joins — production must
 * verify the JWT and check the caller belongs to that trip/driver.
 * Events: client -> server: join { trip_id?, driver_id? }, driver:location
 * { trip_id, lat, lng }. Server -> client: ride:request, trip:accepted,
 * trip:arrived, trip:started, trip:completed, trip:cancelled, driver:location.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class TripsGateway {
  @WebSocketServer() server!: Server;

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { trip_id?: number; driver_id?: number }, @ConnectedSocket() client: Socket) {
    if (data.trip_id) client.join(`trip_${data.trip_id}`);
    if (data.driver_id) client.join(`driver_${data.driver_id}`);
    return { ok: true, rooms: [...client.rooms] };
  }

  @SubscribeMessage('driver:location')
  handleDriverLocation(@MessageBody() data: { trip_id: number; lat: number; lng: number }) {
    if (data.trip_id) {
      this.server.to(`trip_${data.trip_id}`).emit('driver:location', data);
    }
    return { ok: true };
  }

  emitToTrip(tripId: number, event: string, payload: unknown) {
    this.server?.to(`trip_${tripId}`).emit(event, payload);
  }

  emitToDriver(driverId: number, event: string, payload: unknown) {
    this.server?.to(`driver_${driverId}`).emit(event, payload);
  }
}

@Injectable()
export class GatewayService {}

@Module({
  providers: [TripsGateway, GatewayService],
  exports: [TripsGateway],
})
export class GatewayModule {}
