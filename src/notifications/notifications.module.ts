import { Controller, Get, HttpException, HttpStatus, Injectable, Module, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseService, DatabaseModule } from '../common/database';
import { JwtAuthGuard } from '../common/auth';
import { CurrentUser, JwtPayload } from '../common/decorators';

@Injectable()
export class NotificationsService {
  constructor(private db: DatabaseService) {}

  async list(user: JwtPayload) {
    if (user.kind !== 'user') return [];
    return this.db.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [user.sub],
    );
  }

  async markRead(user: JwtPayload, id: number) {
    const res: any = await this.db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND user_id = ?',
      [id, user.sub],
    );
    if (res.affectedRows === 0) throw new HttpException('Notification not found', HttpStatus.NOT_FOUND);
    return { ok: true };
  }
}

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My in-app notifications, newest first' })
  list(@CurrentUser() user: JwtPayload) {
    return this.notifications.list(user);
  }

  @Post(':id/read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark one notification as read' })
  read(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.notifications.markRead(user, Number(id));
  }
}

@Module({ imports: [DatabaseModule], providers: [NotificationsService], controllers: [NotificationsController] })
export class NotificationsModule {}
