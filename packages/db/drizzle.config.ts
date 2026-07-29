import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    // eslint-disable-next-line no-restricted-globals
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/smashclub',
  },
});
