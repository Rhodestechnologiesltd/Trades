import { OnGatewayConnection, WebSocketGateway, WebSocketServer, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../../common/auth';
import { DbService } from '../../common/db.service';

/**
 * WebSocket channel (WSS, §B.1) for live UI updates: new quotes, counter-offers,
 * booking status changes and live provider tracking. Push/SMS remain the
 * delivery-guaranteed channels; sockets are best-effort freshness.
 */
@WebSocketGateway({ path: '/realtime', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;

  constructor(private readonly db: DbService) {}

  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? String(client.handshake.headers.authorization ?? '').replace(/^Bearer /, '');
      const claims = verifyAccessToken(token);
      client.data.userId = claims.sub;
      client.data.role = claims.typ;
      client.join(`user:${claims.sub}`);
      if (['admin', 'support', 'finance'].includes(claims.typ) && claims.mfa) client.join('staff');
    } catch {
      client.disconnect(true);
    }
  }

  /** Subscribe to a booking's live channel — only its customer, its provider, or staff. */
  @SubscribeMessage('booking:subscribe')
  async subscribeBooking(@ConnectedSocket() client: Socket, @MessageBody() body: { bookingId: string }) {
    const b = await this.db.one(`SELECT customer_id, provider_id FROM bookings WHERE id = $1`, [body?.bookingId]).catch(() => null);
    const uid = client.data.userId;
    if (!b || (b.customer_id !== uid && b.provider_id !== uid && client.data.role !== 'admin' && client.data.role !== 'support')) {
      return { ok: false };
    }
    client.join(`booking:${body.bookingId}`);
    return { ok: true };
  }

  toUser(userId: string, event: string, data: unknown) { this.server?.to(`user:${userId}`).emit(event, data); }
  toBooking(bookingId: string, event: string, data: unknown) { this.server?.to(`booking:${bookingId}`).emit(event, data); }
  toStaff(event: string, data: unknown) { this.server?.to('staff').emit(event, data); }
}
