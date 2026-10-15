import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().optional().default('4000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CLERK_SECRET_KEY: z.string().min(1, 'CLERK_SECRET_KEY is required'),
  CORS_ORIGIN: z.string().optional().default('http://localhost:3000'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional().default('receipts@veloce.app'),
  TRACKING_SECRET: z.string().optional().default('veloce_luxury_emergency_tracking_key_2026')
});

export function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('\n❌ CRITICAL: Environment Variable Validation Failed!');
    const formatted = result.error.format();
    console.error(JSON.stringify(formatted, null, 2));
    console.error('Please configure all required variables in your .env file.\n');
    process.exit(1);
  }
  return result.data;
}
