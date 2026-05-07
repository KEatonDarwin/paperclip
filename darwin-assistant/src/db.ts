import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://paperclip:paperclip@192.168.1.52:5432/paperclip',
});

export const DARWIN_COMPANY_ID = 'ffbbb56f-af79-49a0-a95a-9eb89f5b3034';

export async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}
