import express from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { getIO } from '../sockets.js';
import { createConnectAccount, getConnectAccountStatus } from '../services/stripe.js';

export const driverRouter = express.Router();

// Middleware to guard driver endpoints against unprivileged riders
export const requireDriver = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Public reviews endpoint does not require driver role
  if (req.path.includes('/reviews')) {
    return next();
  }

  return requireRole('DRIVER', 'ADMIN')(req, res, next);
};

driverRouter.use(requireDriver);

const onlineSchema = z.object({
  lat: z.number().optional().default(28.6315),
  lng: z.number().optional().default(77.2167),
  vehicleType: z.string().optional().default("Veloce X"),
});

const locationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

// Haversine formula in km
export function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

driverRouter.get('/profile', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    let profile = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
    if (!profile) {
      profile = await prisma.driverProfile.create({
        data: {
          userId: user.id,
          vehicleType: "Veloce X",
          vehicleModel: "Mercedes-Benz E-Class",
          plateNumber: "DL 01 AB 1234",
          isOnline: false,
          lat: 28.6315,
          lng: 77.2167,
          avgRating: 4.9,
          ratingCount: 120
        }
      });
    }
    res.json({ data: profile });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'PROFILE_ERROR', message } });
  }
});

const updateProfileSchema = z.object({
  vehicleType: z.string().optional(),
  vehicleModel: z.string().optional(),
  plateNumber: z.string().optional(),
});

driverRouter.put('/profile', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i: { message: string }) => i.message).join(', ')
        }
      });
    }

    const profile = await prisma.driverProfile.upsert({
      where: { userId: user.id },
      update: {
        ...(parsed.data.vehicleType && { vehicleType: parsed.data.vehicleType }),
        ...(parsed.data.vehicleModel && { vehicleModel: parsed.data.vehicleModel }),
        ...(parsed.data.plateNumber && { plateNumber: parsed.data.plateNumber }),
      },
      create: {
        userId: user.id,
        vehicleType: parsed.data.vehicleType || "Veloce X",
        vehicleModel: parsed.data.vehicleModel || "Mercedes-Benz E-Class",
        plateNumber: parsed.data.plateNumber || "DL 01 AB 1234",
        isOnline: false,
      }
    });

    res.json({ data: profile });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'PROFILE_UPDATE_ERROR', message } });
  }
});

driverRouter.post('/online', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    
    const parsed = onlineSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i: { message: string }) => i.message).join(', ')
        }
      });
    }

    const { lat, lng, vehicleType } = parsed.data;

    const profile = await prisma.driverProfile.upsert({
      where: { userId: user.id },
      update: {
        isOnline: true,
        lat,
        lng,
        ...(vehicleType && { vehicleType }),
        locationUpdatedAt: new Date()
      },
      create: {
        userId: user.id,
        vehicleType,
        vehicleModel: "Mercedes-Benz E-Class",
        plateNumber: "DL 01 AB 1234",
        isOnline: true,
        lat,
        lng,
        locationUpdatedAt: new Date(),
        avgRating: 4.9,
        ratingCount: 120
      }
    });

    console.log(`[Driver API] Driver ${user.id} is online at (${profile.lat}, ${profile.lng}) with vehicle ${profile.vehicleType}`);
    res.json({ data: { success: true, profile } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error("[Driver API] Error setting online:", message);
    res.status(500).json({ error: { code: 'ONLINE_ERROR', message } });
  }
});

driverRouter.post('/offline', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    await prisma.driverProfile.upsert({
      where: { userId: user.id },
      update: { isOnline: false },
      create: {
        userId: user.id,
        vehicleType: "Veloce X",
        isOnline: false
      }
    });
    res.json({ data: { success: true } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'OFFLINE_ERROR', message } });
  }
});

driverRouter.post('/location', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    
    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i: { message: string }) => i.message).join(', ')
        }
      });
    }

    const { lat, lng } = parsed.data;
    const profile = await prisma.driverProfile.update({
      where: { userId: user.id },
      data: {
        lat,
        lng,
        locationUpdatedAt: new Date()
      }
    });

    // Broadcast location to active ride room if driver is in a trip
    try {
      const activeRide = await prisma.ride.findFirst({
        where: {
          OR: [
            { driverId: user.id },
            { driverId: user.clerkId }
          ],
          status: { in: ["ACCEPTED", "ARRIVED", "IN_PROGRESS"] }
        },
        orderBy: { updatedAt: 'desc' }
      });
      console.log(`[Driver API Location] user=${user.id}, clerkId=${user.clerkId}, found active ride:`, activeRide?.id);
      if (activeRide) {
        const io = getIO();
        io.to(`ride:${activeRide.id}`).emit('driver:location', {
          rideId: activeRide.id,
          lat,
          lng
        });
      }
    } catch (e) {
      console.error("[Driver API Location] Socket emit error:", e);
    }

    res.json({ data: { success: true, profile } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'LOCATION_ERROR', message } });
  }
});

driverRouter.get('/requests', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    const profile = await prisma.driverProfile.findUnique({ where: { userId: user.id } });

    const driverLat = profile?.lat ?? 28.6315;
    const driverLng = profile?.lng ?? 77.2167;
    const vehicleType = profile?.vehicleType || "Veloce X";

    // Query requested rides matching vehicle type
    const rides = await prisma.ride.findMany({
      where: { 
        status: "REQUESTED",
        vehicleType
      },
      orderBy: { createdAt: "desc" },
      take: 20
    });

    // 5 km filter (with fallback to all active requests for local development)
    const within5km = rides.filter(r => {
      const dist = getDistanceKm(r.pickupLat, r.pickupLng, driverLat, driverLng);
      return dist <= 5.0;
    });

    const candidateRides = within5km.length > 0 ? within5km : rides;
    res.json({ data: candidateRides });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'REQUESTS_ERROR', message } });
  }
});

// POST /api/driver/payouts/onboard
driverRouter.post('/payouts/onboard', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;

    const connect = await createConnectAccount(user.id, user.email || undefined);

    await prisma.driverProfile.upsert({
      where: { userId: user.id },
      update: { stripeAccountId: connect.accountId, payoutsEnabled: true },
      create: {
        userId: user.id,
        vehicleType: "Veloce X",
        stripeAccountId: connect.accountId,
        payoutsEnabled: true
      }
    });

    res.json({ data: { onboardingUrl: connect.onboardingUrl, accountId: connect.accountId } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'PAYOUT_ONBOARD_ERROR', message } });
  }
});

// GET /api/driver/payouts/status
driverRouter.get('/payouts/status', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    const profile = await prisma.driverProfile.findUnique({ where: { userId: user.id } });

    if (!profile?.stripeAccountId) {
      return res.json({ data: { payoutsEnabled: false, accountId: null, pendingOnboarding: true } });
    }

    const status = await getConnectAccountStatus(profile.stripeAccountId);
    if (status.payoutsEnabled !== profile.payoutsEnabled) {
      await prisma.driverProfile.update({
        where: { userId: user.id },
        data: { payoutsEnabled: status.payoutsEnabled }
      });
    }

    res.json({ data: { payoutsEnabled: status.payoutsEnabled, accountId: profile.stripeAccountId } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'PAYOUT_STATUS_ERROR', message } });
  }
});

// GET /api/driver/earnings
driverRouter.get('/earnings', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    const profile = await prisma.driverProfile.findUnique({ where: { userId: user.id } });

    const completedRides = await prisma.ride.findMany({
      where: {
        driverId: user.id,
        status: { in: ["COMPLETED", "PAID"] }
      },
      include: { payment: true },
      orderBy: { completedAt: "desc" }
    });

    let totalEarningsPaise = 0;
    const ridesSummary = completedRides.map(ride => {
      const farePaise = ride.fareFinalPaise || ride.fareEstimatePaise;
      const driverCut = ride.payment?.driverPayoutPaise || Math.round(farePaise * 0.8);
      if (ride.payment?.status === "PAID" || ride.status === "COMPLETED") {
        totalEarningsPaise += driverCut;
      }
      return {
        id: ride.id,
        createdAt: ride.createdAt,
        pickupAddress: ride.pickupAddress,
        dropAddress: ride.dropAddress,
        fareFinalPaise: farePaise,
        driverPayoutPaise: driverCut,
        status: ride.payment?.status || ride.status
      };
    });

    const pendingPayoutsPaise = (!profile?.payoutsEnabled) ? totalEarningsPaise : 0;

    res.json({
      data: {
        totalEarningsPaise,
        pendingPayoutsPaise,
        payoutsEnabled: Boolean(profile?.payoutsEnabled),
        totalTrips: completedRides.length,
        rides: ridesSummary
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'EARNINGS_ERROR', message } });
  }
});

// GET /api/driver/:id/reviews or /api/drivers/:id/reviews
driverRouter.get('/:id/reviews', async (req: express.Request, res: express.Response) => {
  const driverId = String(req.params.id);
  try {
    const ratings = await prisma.rating.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    const reviews = await Promise.all(
      ratings.map(async (r) => {
        const rider = await prisma.user.findUnique({ where: { id: r.riderId } });
        return {
          id: r.id,
          stars: r.stars,
          comment: r.comment,
          createdAt: r.createdAt,
          riderName: rider?.name || 'Veloce Passenger'
        };
      })
    );

    res.json({ data: reviews });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Reviews error';
    res.status(500).json({ error: { code: 'REVIEWS_ERROR', message } });
  }
});


