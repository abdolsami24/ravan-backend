import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * Thin mysql2/promise wrapper used by every module.
 * Pool is created from env vars (see .env.example). All queries use
 * placeholders — never string-concatenate user input into SQL.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: mysql.Pool;

  constructor(private config: ConfigService) {
    this.pool = mysql.createPool({
      host: config.get<string>('DB_HOST', 'localhost'),
      port: Number(config.get<string>('DB_PORT', '3306')),
      user: config.get<string>('DB_USER'),
      password: config.get<string>('DB_PASS', ''),
      database: config.get<string>('DB_NAME', 'ravan'),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      dateStrings: true,
      charset: 'utf8mb4',
    });
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const [rows] = await this.pool.execute(sql, params);
    return rows as T[];
  }

  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** Run work inside one transaction; the callback receives the connection. */
  async transaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
