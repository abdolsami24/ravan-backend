import { DatabaseService } from './database';

/** Insert one in-app notification row (FCM push is a later phase). */
export async function insertNotification(
  db: DatabaseService,
  userId: number,
  type: string,
  title: string,
  body: string,
  data: Record<string, unknown> | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, type, title, body, data ? JSON.stringify(data) : null],
  );
}
