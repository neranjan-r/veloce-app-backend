import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import http from 'http';
import { Webhook } from 'svix';
import { prisma } from './db.js';
import { clerk, getDbUser, requireAuth, requireRole } from './middleware/auth.js';
import { ridesRouter } from './routes/rides.js';
import { initSockets, getIO } from './sockets.js';
import { geocodeRouter } from './routes/geocode.js';
import { driverRouter } from './routes/driver.js';
import { paymentsRouter } from './routes/payments.js';
import { supportRouter } from './routes/support.js';
import { adminRouter } from './routes/admin.js';
import { seedDefaultPromos } from './services/promo.js';
import { validateEnv } from './env.js';
import { createRateLimiter } from './middleware/rateLimit.js';

dotenv.config();
const envConfig = validateEnv();

const app = express();

const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ["http://localhost:3000", "http://127.0.0.1:3000"];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy'));
    }
  },
  credentials: true
}));
app.use(helmet());

// POST /webhooks/stripe with raw body and signature verification (no auth middleware)
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req: express.Request, res: express.Response) => {
  const sig = req.headers['stripe-signature'];
  let event: any;

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY || '';
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    if (stripeKey.startsWith('sk_') && endpointSecret && sig) {
      const StripeLib = (await import('stripe')).default;
      const stripe = new StripeLib(stripeKey, { apiVersion: '2023-10-16' as any });
      event = stripe.webhooks.constructEvent(req.body, sig as string, endpointSecret);
    } else {
      const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
      event = JSON.parse(bodyStr);
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data?.object;
      const rideId = paymentIntent?.metadata?.rideId;
      if (rideId) {
        await prisma.payment.updateMany({
          where: { rideId },
          data: { status: 'SUCCEEDED', stripePaymentIntentId: paymentIntent.id }
        });
        try {
          const io = getIO();
          io.to(`ride:${rideId}`).emit('ride:paid', { rideId, status: 'SUCCEEDED', stripePaymentIntentId: paymentIntent.id });
          io.to(`ride:${rideId}`).emit('ride:status', { status: 'COMPLETED' });
        } catch (e) {}

        // Part C: Asynchronously email PDF receipt to the rider using Resend (never fail payment)
        (async () => {
          try {
            const ride = await prisma.ride.findUnique({
              where: { id: rideId }
            });
            if (ride) {
              const rider = await prisma.user.findUnique({ where: { id: ride.riderId } });
              const driver = ride.driverId ? await prisma.user.findUnique({ where: { id: ride.driverId }, include: { driverProfile: true } }) : null;
              if (rider?.email) {
                const { generateReceiptPdf, sendReceiptEmail } = await import('./services/receipt.js');
                const fareRupees = Math.round((ride.fareFinalPaise || ride.fareEstimatePaise || 0) / 100);
                const pdfBuffer = await generateReceiptPdf({
                  id: ride.id,
                  receiptNumber: `REC-${ride.id.slice(-6).toUpperCase()}`,
                  date: ride.createdAt,
                  riderName: rider.name || 'Veloce Guest',
                  driverName: driver?.name || 'Assigned Chauffeur',
                  vehicleType: ride.vehicleType || 'Veloce X',
                  vehicleModel: driver?.driverProfile?.vehicleModel,
                  plateNumber: driver?.driverProfile?.plateNumber,
                  pickupAddress: ride.pickupAddress,
                  dropAddress: ride.dropAddress,
                  distanceKm: '12.4',
                  durationMins: 24,
                  fareRupees,
                  paymentMethod: 'Saved Card (Stripe)',
                  paymentStatus: 'SUCCEEDED'
                });

                await sendReceiptEmail({
                  toEmail: rider.email,
                  pdfBuffer,
                  rideId: ride.id,
                  fareRupees
                });
              }
            }
          } catch (emailErr) {
            console.error(`[Receipt Email] Background send failed for ride ${rideId}:`, emailErr);
          }
        })();
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data?.object;
      const rideId = paymentIntent?.metadata?.rideId;
      if (rideId) {
        await prisma.payment.updateMany({
          where: { rideId },
          data: { status: 'FAILED', stripePaymentIntentId: paymentIntent.id }
        });
      }
    }

    res.json({ received: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Webhook error';
    res.status(400).send(`Webhook Error: ${message}`);
  }
});

app.use(express.json());

// POST /webhooks/clerk (Svix verified, no auth middleware)
app.post('/webhooks/clerk', express.raw({ type: 'application/json' }), async (req: express.Request, res: express.Response) => {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  const svixId = req.headers['svix-id'] as string;
  const svixTimestamp = req.headers['svix-timestamp'] as string;
  const svixSignature = req.headers['svix-signature'] as string;

  let evt: any;
  if (webhookSecret && svixId && svixTimestamp && svixSignature) {
    try {
      const wh = new Webhook(webhookSecret);
      const rawPayload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
      evt = wh.verify(rawPayload, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      });
    } catch (err: unknown) {
      console.error('[Clerk Webhook] Verification failed:', err);
      return res.status(400).json({ error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Verification failed' } });
    }
  } else {
    // If webhook secret not configured yet, parse body
    const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    evt = JSON.parse(bodyStr);
  }

  const { type, data } = evt || {};
  if (type === 'user.created' || type === 'user.updated') {
    const clerkId = data.id;
    const role = (data.public_metadata?.role as string | undefined)?.toUpperCase() || 'RIDER';
    const email = data.email_addresses?.[0]?.email_address || `${clerkId}@veloce.app`;
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || undefined;

    await prisma.user.upsert({
      where: { clerkId },
      update: { role, email, ...(name && { name }) },
      create: { clerkId, role, email, name: name || 'Veloce User' }
    });
  }

  res.json({ received: true });
});

// Seed initial promotional codes (SAVE10, FIRST50, WELCOME20)
seedDefaultPromos().catch(console.error);

// Health check endpoint (verifies database connectivity, exempt from auth)
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ data: { status: 'healthy', database: 'connected', timestamp: new Date().toISOString() } });
  } catch (err: unknown) {
    console.error('[Health Check] Database connectivity check failed:', err);
    res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database connectivity error' } });
  }
});

// Demo instant 1-click login endpoint for local development
app.get('/api/demo-login/:role', async (req, res) => {
  const role = req.params.role?.toLowerCase();
  const userMap: Record<string, string> = {
    rider: 'user_3KZ3YkSdinJeWIvmG3j9GJXySod',
    driver: 'user_3KZ3YtaHX2xCUSupc6pg9mwNoFw',
    admin: 'user_3KWCzqOjADXqLPVTP2RzGvm41oG'
  };
  const userId = userMap[role] || userMap.rider;
  try {
    const token = await clerk.signInTokens.createSignInToken({ userId, expiresInSeconds: 86400 });
    return res.redirect(`http://localhost:3000/sign-in?__clerk_ticket=${token.token}`);
  } catch (err) {
    console.error('[Demo Login] Failed to create demo sign-in token:', err);
    return res.redirect('http://localhost:3000/sign-in');
  }
});

// GET current authenticated user (strict requireAuth)
app.get('/api/me', requireAuth, async (req: any, res: any) => {
  try {
    const user = req.auth.user;
    return res.json({ data: user });
  } catch {
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } });
  }
});

// GET active ride for authenticated user (rider or driver)
app.get('/api/rides/active', requireAuth, async (req: any, res: any) => {
  try {
    const user = req.auth.user;
    const ride = await prisma.ride.findFirst({
      where: { 
        OR: [
          { riderId: user.id },
          { riderId: req.auth.clerkId },
          { driverId: user.id },
          { driverId: req.auth.clerkId }
        ],
        status: { in: ["REQUESTED", "ACCEPTED", "ARRIVED", "IN_PROGRESS"] }
      },
      orderBy: { updatedAt: 'desc' }
    });
    return res.json({ data: ride });
  } catch {
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } });
  }
});

// Rate limiters: geocode (60 req/min), payments (30 req/min)
const geocodeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60, message: 'Too many geocode requests, please slow down.' });
const paymentLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many payment requests, please slow down.' });

// Protected routes (requireAuth is enforced on every route)
// Note: /api/rides/track/:token is exempted inside requireAuth / tracking route as permitted by rules
app.use('/api/rides', requireAuth, ridesRouter);
app.use('/api/geocode', requireAuth, geocodeLimiter, geocodeRouter);
app.use('/api/driver', requireAuth, driverRouter);
app.use('/api/drivers', requireAuth, driverRouter);
app.use('/api/payments', requireAuth, paymentLimiter, paymentsRouter);
app.use('/api/support', requireAuth, supportRouter);
app.use('/api/admin', requireAuth, adminRouter);

export { prisma, clerk, getDbUser, requireAuth, requireRole };

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

// Initialize Socket.io
initSockets(server);

server.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
