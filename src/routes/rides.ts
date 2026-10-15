import express from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { calculateFare } from '../services/fare.js';
import { getRoute } from '../services/routing.js';
import { getIO } from '../sockets.js';
import { getOrCreateCustomer, createPaymentIntent, transferToDriver, isRealStripe } from '../services/stripe.js';
import { generateReceiptPdf } from '../services/receipt.js';

import { validatePromoCode } from '../services/promo.js';
import { generateTrackingToken, verifyTrackingToken } from '../services/tracking.js';

export const ridesRouter = express.Router();

const stopSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().optional(),
});

const estimateSchema = z.object({
  pickup: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string().optional(),
  }),
  drop: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string().optional(),
  }),
  stops: z.array(stopSchema).max(3).optional(),
  vehicleType: z.string().optional().default('Veloce X'),
  promoCode: z.string().optional(),
});

const createRideSchema = z.object({
  pickupLat: z.number(),
  pickupLng: z.number(),
  pickupAddress: z.string().min(1),
  dropLat: z.number(),
  dropLng: z.number(),
  dropAddress: z.string().min(1),
  stops: z.array(z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string().min(1),
  })).max(3).optional(),
  vehicleType: z.string().optional().default('Veloce X'),
  promoCode: z.string().optional(),
});

// Helper to populate driver details on ride
export async function attachDriverToRide(ride: any) {
  if (!ride) return null;
  let driver = null;
  if (ride.driverId) {
    const driverUser = await prisma.user.findUnique({
      where: { id: ride.driverId },
      include: { driverProfile: true }
    });
    if (driverUser) {
      driver = {
        id: driverUser.id,
        name: driverUser.name || "Chauffeur",
        phone: driverUser.phone || "+91 98765 43210",
        vehicleType: driverUser.driverProfile?.vehicleType || ride.vehicleType,
        vehicleModel: driverUser.driverProfile?.vehicleModel || "Mercedes-Benz E-Class",
        plateNumber: driverUser.driverProfile?.plateNumber || "DL 01 AB 1234",
        avgRating: driverUser.driverProfile?.avgRating || 4.9,
        lat: driverUser.driverProfile?.lat ?? (ride.status === "COMPLETED" ? ride.dropLat : ride.pickupLat),
        lng: driverUser.driverProfile?.lng ?? (ride.status === "COMPLETED" ? ride.dropLng : ride.pickupLng)
      };
    }
  }
  return { ...ride, driver };
}

// GET /api/rides/history
ridesRouter.get('/history', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string, 10) || 10));
    const status = req.query.status as string;

    const whereClause: any = {
      OR: [
        { riderId: user.id },
        { driverId: user.id }
      ]
    };

    if (status && status !== 'ALL') {
      whereClause.status = status;
    }

    const totalCount = await prisma.ride.count({ where: whereClause });
    const totalPages = Math.ceil(totalCount / limit);

    const rides = await prisma.ride.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    });

    // Populate driver info for completed/past rides
    const ridesWithDrivers = await Promise.all(
      rides.map(async (r) => {
        let driver = null;
        if (r.driverId) {
          const driverUser = await prisma.user.findUnique({
            where: { id: r.driverId },
            include: { driverProfile: true }
          });
          if (driverUser) {
            driver = {
              id: driverUser.id,
              name: driverUser.name || "Chauffeur",
              phone: driverUser.phone || "+91 98765 43210",
              vehicleType: driverUser.driverProfile?.vehicleType || r.vehicleType,
              vehicleModel: driverUser.driverProfile?.vehicleModel || "Mercedes-Benz E-Class",
              plateNumber: driverUser.driverProfile?.plateNumber || "DL 01 AB 1234",
              avgRating: driverUser.driverProfile?.avgRating || 4.9
            };
          }
        }
        return { ...r, driver };
      })
    );

    res.json({
      data: {
        rides: ridesWithDrivers,
        pagination: {
          page,
          limit,
          totalPages,
          totalCount
        }
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});

// POST /api/rides/estimate
ridesRouter.post('/estimate', async (req: express.Request, res: express.Response) => {
  const parseResult = estimateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: parseResult.error.issues.map((i: { message: string }) => i.message).join(', ')
      }
    });
  }

  const { pickup, drop, stops, vehicleType, promoCode } = parseResult.data;

  try {
    const points: [number, number][] = [
      [pickup.lat, pickup.lng],
      ...(stops || []).map(s => [s.lat, s.lng] as [number, number]),
      [drop.lat, drop.lng]
    ];
    const route = await getRoute(points);
    const baseFare = calculateFare(route.distanceMeters, route.durationSeconds, vehicleType);

    let discountPaise = 0;
    let finalFare = baseFare;
    let promoDetails = null;

    if (promoCode) {
      const promoResult = await validatePromoCode(promoCode, baseFare);
      if (promoResult.valid) {
        discountPaise = promoResult.discountPaise;
        finalFare = promoResult.discountedFarePaise;
        promoDetails = {
          code: promoResult.code,
          discountPaise: promoResult.discountPaise,
          percentOff: promoResult.percentOff,
          flatOffPaise: promoResult.flatOffPaise
        };
      }
    }
    
    res.json({
      data: {
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        fareEstimatePaise: finalFare,
        baseFarePaise: baseFare,
        discountPaise,
        promo: promoDetails,
        stopsCount: stops?.length || 0,
        geometry: route.geometry
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'ESTIMATE_ERROR', message } });
  }
});

// POST /api/rides
ridesRouter.post('/', async (req: express.Request, res: express.Response) => {
  const parseResult = createRideSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: parseResult.error.issues.map((i: { message: string }) => i.message).join(', ')
      }
    });
  }

  const { pickupLat, pickupLng, pickupAddress, dropLat, dropLng, dropAddress, stops, vehicleType, promoCode } = parseResult.data;

  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    
    const vType = vehicleType || "Veloce X";
    const points: [number, number][] = [
      [pickupLat, pickupLng],
      ...(stops || []).map(s => [s.lat, s.lng] as [number, number]),
      [dropLat, dropLng]
    ];
    const route = await getRoute(points);
    const baseFare = calculateFare(route.distanceMeters, route.durationSeconds, vType);

    let discountPaise = 0;
    let finalFare = baseFare;
    let promoId: string | undefined = undefined;

    if (promoCode) {
      const promoResult = await validatePromoCode(promoCode, baseFare);
      if (promoResult.valid) {
        discountPaise = promoResult.discountPaise;
        finalFare = promoResult.discountedFarePaise;
        const promoRecord = await prisma.promoCode.findUnique({ where: { code: promoResult.code } });
        if (promoRecord) {
          promoId = promoRecord.id;
          await prisma.promoCode.update({
            where: { id: promoRecord.id },
            data: { usedCount: { increment: 1 } }
          });
        }
      }
    }

    const ride = await prisma.ride.create({
      data: {
        riderId: user.id,
        vehicleType: vType,
        pickupLat,
        pickupLng,
        pickupAddress,
        dropLat,
        dropLng,
        dropAddress,
        distanceMeters: Math.round(route.distanceMeters),
        durationSeconds: Math.round(route.durationSeconds),
        fareEstimatePaise: finalFare,
        promoCodeId: promoId,
        discountPaise: discountPaise > 0 ? discountPaise : undefined,
        status: "REQUESTED",
        rideStops: stops && stops.length > 0 ? {
          create: stops.map((s, idx) => ({
            position: idx + 1,
            lat: s.lat,
            lng: s.lng,
            address: s.address
          }))
        } : undefined
      },
      include: {
        rideStops: true
      }
    });

    console.log(`[Rides API] Created ride ${ride.id} (${vType}) with ${stops?.length || 0} stops`);

    // Emit ride:requested event to driver rooms
    try {
      const io = getIO();
      console.log(`[Rides API] Emitting ride:requested to drivers:${vType} and drivers`);
      io.to(`drivers:${vType}`).emit('ride:requested', ride);
      io.to('drivers').emit('ride:requested', ride);
    } catch (e) {
      console.error("[Rides API] Failed to emit socket event:", e);
    }
    
    res.json({ data: ride });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error("[Rides API] Ride creation error:", message);
    res.status(500).json({ error: { code: 'RIDE_CREATE_ERROR', message } });
  }
});

// GET /api/rides/:id
ridesRouter.get('/:id', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = ((req as any).auth?.claims?.role || user.role || "RIDER").toUpperCase();

    const rideId = String(req.params.id);
    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    // Access control: only ride's rider, assigned driver, or ADMIN may access
    const isParticipant = ride.riderId === user.id || ride.driverId === user.id || role === 'ADMIN';
    if (!isParticipant) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not have permission to access this ride' }
      });
    }

    let driver = null;
    if (ride.driverId) {
      const driverUser = await prisma.user.findUnique({
        where: { id: ride.driverId },
        include: { driverProfile: true }
      });
      if (driverUser) {
        driver = {
          id: driverUser.id,
          name: driverUser.name || "Chauffeur",
          phone: driverUser.phone || "+91 98765 43210",
          vehicleType: driverUser.driverProfile?.vehicleType || ride.vehicleType,
          vehicleModel: driverUser.driverProfile?.vehicleModel || "Mercedes-Benz E-Class",
          plateNumber: driverUser.driverProfile?.plateNumber || "DL 01 AB 1234",
          avgRating: driverUser.driverProfile?.avgRating || 4.9,
          lat: driverUser.driverProfile?.lat,
          lng: driverUser.driverProfile?.lng
        };
      }
    }

    res.json({ data: { ...ride, driver } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});

// POST /api/rides/:id/accept
ridesRouter.post('/:id/accept', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = ((req as any).auth?.claims?.role || user.role || "DRIVER").toUpperCase();
    if (role !== 'DRIVER' && role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only drivers can accept rides' } });
    }

    const updated = await prisma.ride.updateMany({
      where: {
        id: rideId,
        status: "REQUESTED"
      },
      data: {
        status: "ACCEPTED",
        driverId: user.id,
        acceptedAt: new Date()
      }
    });

    if (updated.count === 0) {
      console.log(`[Rides API] Ride ${rideId} accept rejected: already accepted or not REQUESTED`);
      return res.status(409).json({
        error: {
          code: 'RIDE_ALREADY_ACCEPTED',
          message: 'Ride already accepted by another driver or no longer available'
        }
      });
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    let driverProfile = await prisma.driverProfile.findUnique({ where: { userId: user.id } });

    // In local development, if driver is far from pickup or not set, position driver near pickup (~300m away)
    if (ride && driverProfile) {
      const currentLat = driverProfile.lat ?? ride.pickupLat;
      const currentLng = driverProfile.lng ?? ride.pickupLng;
      // Rough distance check
      const latDiff = Math.abs(currentLat - ride.pickupLat);
      const lngDiff = Math.abs(currentLng - ride.pickupLng);
      if (latDiff > 0.1 || lngDiff > 0.1) {
        driverProfile = await prisma.driverProfile.update({
          where: { userId: user.id },
          data: {
            lat: ride.pickupLat + 0.003,
            lng: ride.pickupLng + 0.003,
            locationUpdatedAt: new Date()
          }
        });
      }
    }

    const driverDetails = {
      id: user.id,
      name: user.name || "Chauffeur",
      phone: user.phone || "+91 98765 43210",
      vehicleType: driverProfile?.vehicleType || ride?.vehicleType || "Veloce X",
      vehicleModel: driverProfile?.vehicleModel || "Mercedes-Benz E-Class",
      plateNumber: driverProfile?.plateNumber || "DL 01 AB 1234",
      avgRating: driverProfile?.avgRating || 4.9,
      lat: driverProfile?.lat ?? (ride ? ride.pickupLat + 0.003 : undefined),
      lng: driverProfile?.lng ?? (ride ? ride.pickupLng + 0.003 : undefined)
    };

    console.log(`[Rides API] Driver ${user.id} ACCEPTED ride ${rideId}`);

    try {
      const io = getIO();
      io.to(`ride:${rideId}`).emit('ride:accepted', { ride, driver: driverDetails });
      io.to(`ride:${rideId}`).emit('ride:status', { status: "ACCEPTED", ride, driver: driverDetails });

      io.to('drivers').emit('ride:accepted', { rideId });
      if (ride) {
        io.to(`drivers:${ride.vehicleType}`).emit('ride:accepted', { rideId });
      }
    } catch (e) {
      console.error("[Rides API] Socket error on accept:", e);
    }

    res.json({ data: { success: true, ride, driver: driverDetails } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error("[Rides API] Error accepting ride:", message);
    res.status(500).json({ error: { code: 'ACCEPT_ERROR', message } });
  }
});

// POST /api/rides/:id/arrived
ridesRouter.post('/:id/arrived', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = ((req as any).auth?.claims?.role || user.role || "DRIVER").toUpperCase();
    const existing = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }
    if (existing.driverId !== user.id && role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized for this ride' } });
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: { status: "ARRIVED" }
    });

    const ride = await attachDriverToRide(updated);
    console.log(`[Rides API] Ride ${rideId} status: ARRIVED`);
    try {
      const io = getIO();
      io.to(`ride:${rideId}`).emit('ride:status', { status: "ARRIVED", ride, driver: ride.driver });
    } catch (e) {}

    res.json({ data: ride });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'ARRIVED_ERROR', message } });
  }
});

// POST /api/rides/:id/start
ridesRouter.post('/:id/start', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = ((req as any).auth?.claims?.role || user.role || "DRIVER").toUpperCase();
    const existing = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }
    if (existing.driverId !== user.id && role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized for this ride' } });
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: { status: "IN_PROGRESS", startedAt: new Date() }
    });

    const ride = await attachDriverToRide(updated);
    console.log(`[Rides API] Ride ${rideId} status: IN_PROGRESS`);
    try {
      const io = getIO();
      io.to(`ride:${rideId}`).emit('ride:status', { status: "IN_PROGRESS", ride, driver: ride.driver });
    } catch (e) {}

    res.json({ data: ride });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'START_ERROR', message } });
  }
});

// POST /api/rides/:id/complete
ridesRouter.post('/:id/complete', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = ((req as any).auth?.claims?.role || user.role || "DRIVER").toUpperCase();
    const existing = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }
    if (existing.driverId !== user.id && role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized for this ride' } });
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: { status: "COMPLETED", completedAt: new Date() }
    });

    const ride = await attachDriverToRide(updated);
    console.log(`[Rides API] Ride ${rideId} status: COMPLETED with driver:`, ride.driver?.name);
    try {
      const io = getIO();
      io.to(`ride:${rideId}`).emit('ride:status', { status: "COMPLETED", ride, driver: ride.driver });
    } catch (e) {}

    res.json({ data: ride });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'COMPLETE_ERROR', message } });
  }
});

// POST /api/rides/:id/cancel
ridesRouter.post('/:id/cancel', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    let cancellationFeePaise = 0;
    if (ride.status === "REQUESTED") {
      cancellationFeePaise = 0;
    } else if (ride.status === "ACCEPTED") {
      const acceptedTime = ride.acceptedAt ? new Date(ride.acceptedAt).getTime() : 0;
      const elapsed = Date.now() - acceptedTime;
      if (elapsed <= 2 * 60 * 1000) {
        cancellationFeePaise = 0;
      } else {
        cancellationFeePaise = 2000;
      }
    } else {
      cancellationFeePaise = 2000;
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: {
        status: "CANCELLED",
        cancelledBy: user.role || "RIDER",
        cancellationFeePaise
      }
    });

    console.log(`[Rides API] Ride ${rideId} CANCELLED by ${user.id} with fee ${cancellationFeePaise} paise`);

    try {
      const io = getIO();
      io.to(`ride:${rideId}`).emit('ride:cancelled', { rideId, ride: updated, cancellationFeePaise });
      io.to(`ride:${rideId}`).emit('ride:status', { status: "CANCELLED", ride: updated });

      io.to('drivers').emit('ride:cancelled', { rideId });
      io.to(`drivers:${ride.vehicleType}`).emit('ride:cancelled', { rideId });
    } catch (e) {}

    res.json({ data: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'CANCEL_ERROR', message } });
  }
});

// POST /api/rides/:id/sos
ridesRouter.post('/:id/sos', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    const lat = typeof req.body?.lat === 'number' ? req.body.lat : ride.pickupLat;
    const lng = typeof req.body?.lng === 'number' ? req.body.lng : ride.pickupLng;

    const sosEvent = await prisma.sosEvent.create({
      data: {
        rideId,
        userId: user.id,
        lat,
        lng,
        resolved: false
      }
    });

    const token = generateTrackingToken(rideId);
    const trackingUrl = `/track/${token}`;

    console.log(`[Rides API] SOS TRIGGERED for ride ${rideId} by user ${user.id}. Token generated.`);

    try {
      const io = getIO();
      io.to('admins').emit('sos:alert', { rideId, sosEvent, trackingUrl });
      io.to('admin').emit('sos:alert', { rideId, sosEvent, trackingUrl });
      io.to(`ride:${rideId}`).emit('sos:alert', { rideId, sosEvent, trackingUrl });
    } catch (e) {}

    res.json({
      data: {
        success: true,
        sosEvent,
        trackingToken: token,
        trackingUrl
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'SOS error';
    res.status(500).json({ error: { code: 'SOS_ERROR', message } });
  }
});

// GET /api/rides/track/:token (Emergency tracking link for contacts)
ridesRouter.get('/track/:token', async (req: express.Request, res: express.Response) => {
  const token = String(req.params.token);
  const payload = verifyTrackingToken(token);
  if (!payload) {
    return res.status(401).json({
      error: {
        code: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Emergency tracking link is invalid or has expired (12h limit).'
      }
    });
  }

  try {
    const ride = await prisma.ride.findUnique({
      where: { id: payload.rideId },
      include: { rideStops: true }
    });

    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    let driver = null;
    if (ride.driverId) {
      const driverUser = await prisma.user.findUnique({
        where: { id: ride.driverId },
        include: { driverProfile: true }
      });
      if (driverUser) {
        driver = {
          id: driverUser.id,
          name: driverUser.name || 'Private Chauffeur',
          phone: driverUser.phone || '+91 98765 43210',
          vehicleType: driverUser.driverProfile?.vehicleType || ride.vehicleType,
          vehicleModel: driverUser.driverProfile?.vehicleModel || 'Mercedes-Benz E-Class',
          plateNumber: driverUser.driverProfile?.plateNumber || 'DL 01 AB 1234',
          avgRating: driverUser.driverProfile?.avgRating || 4.9,
          lat: driverUser.driverProfile?.lat || ride.pickupLat,
          lng: driverUser.driverProfile?.lng || ride.pickupLng
        };
      }
    }

    const activeSos = await prisma.sosEvent.findFirst({
      where: { rideId: ride.id, resolved: false },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      data: {
        ride,
        driver,
        stops: ride.rideStops,
        sosActive: !!activeSos,
        sosEvent: activeSos,
        expiresAt: payload.expiresAt
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Track error';
    res.status(500).json({ error: { code: 'TRACK_ERROR', message } });
  }
});

// POST /api/rides/promo/validate
ridesRouter.post('/promo/validate', async (req: express.Request, res: express.Response) => {
  try {
    const { code, fareEstimatePaise } = req.body || {};
    if (!code) {
      return res.status(400).json({ error: { code: 'MISSING_CODE', message: 'Promo code required' } });
    }
    const result = await validatePromoCode(String(code), typeof fareEstimatePaise === 'number' ? fareEstimatePaise : 10000);
    res.json({ data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Promo validation error';
    res.status(500).json({ error: { code: 'PROMO_ERROR', message } });
  }
});

// POST /api/rides/:id/pay
ridesRouter.post('/:id/pay', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { payment: true }
    });

    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    // Must be rider of the ride
    if (ride.riderId !== user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the rider can pay for this ride' } });
    }

    // Ride must be COMPLETED
    if (ride.status !== 'COMPLETED') {
      return res.status(400).json({ error: { code: 'RIDE_NOT_COMPLETED', message: 'Ride is not completed yet' } });
    }

    // Idempotency: if already paid
    if (ride.payment && ride.payment.status === 'PAID') {
      return res.json({ data: { success: true, payment: ride.payment, alreadyPaid: true } });
    }

    const { paymentMethodId } = req.body || {};
    const amountPaise = ride.fareFinalPaise || ride.fareEstimatePaise;
    const customerId = await getOrCreateCustomer(user);

    // Create payment intent
    const pi = await createPaymentIntent({
      customerId,
      amountPaise,
      paymentMethodId,
      rideId
    });

    const driverPayoutPaise = Math.round(amountPaise * 0.8);
    const platformFeePaise = amountPaise - driverPayoutPaise;

    // Check driver Stripe Connect onboarding
    if (ride.driverId) {
      const driverProfile = await prisma.driverProfile.findUnique({
        where: { userId: ride.driverId }
      });
      if (driverProfile?.stripeAccountId && driverProfile?.payoutsEnabled) {
        try {
          await transferToDriver({
            accountId: driverProfile.stripeAccountId,
            amountPaise: driverPayoutPaise,
            rideId
          });
        } catch (e) {
          console.error("[Payments] Driver transfer failed:", e);
        }
      }
    }

    const initialStatus = isRealStripe ? 'PENDING' : 'SUCCEEDED';

    const payment = await prisma.payment.upsert({
      where: { rideId },
      update: {
        stripePaymentIntentId: pi.id,
        amountPaise,
        status: initialStatus,
        driverPayoutPaise,
        platformFeePaise
      },
      create: {
        rideId,
        stripePaymentIntentId: pi.id,
        amountPaise,
        status: initialStatus,
        driverPayoutPaise,
        platformFeePaise
      }
    });

    try {
      const io = getIO();
      if (initialStatus === 'SUCCEEDED') {
        io.to(`ride:${rideId}`).emit('ride:paid', { rideId, payment });
        io.to(`ride:${rideId}`).emit('ride:status', { status: 'PAID', ride, payment });
      }
    } catch (e) {}

    res.json({ data: { success: true, payment, clientSecret: pi.clientSecret } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Payment failed';
    const code = (err as any)?.code || 'PAYMENT_FAILED';
    console.error("[Payments API] Error processing payment:", err);
    res.status(400).json({ error: { code, message } });
  }
});

// POST /api/rides/:id/rating
const ratingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(300).optional(),
});

ridesRouter.post('/:id/rating', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  const parsed = ratingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') }
    });
  }

  const { stars, comment } = parsed.data;

  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { payment: true, rating: true }
    });

    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    if (ride.riderId !== user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only rider can rate this ride' } });
    }

    if (!ride.driverId) {
      return res.status(400).json({ error: { code: 'NO_DRIVER', message: 'Ride has no assigned driver' } });
    }

    if (ride.payment?.status !== 'PAID') {
      return res.status(400).json({ error: { code: 'RIDE_NOT_PAID', message: 'Ride must be paid before rating' } });
    }

    if (ride.rating) {
      return res.status(409).json({ error: { code: 'RATING_ALREADY_EXISTS', message: 'Ride has already been rated' } });
    }

    const { rating, avgRating } = await prisma.$transaction(async (tx) => {
      const createdRating = await tx.rating.create({
        data: {
          rideId,
          riderId: user.id,
          driverId: ride.driverId!,
          stars,
          comment
        }
      });

      const allRatings = await tx.rating.findMany({
        where: { driverId: ride.driverId! }
      });

      const totalStars = allRatings.reduce((sum, r) => sum + r.stars, 0);
      const newAvg = Number((totalStars / allRatings.length).toFixed(1));

      await tx.driverProfile.update({
        where: { userId: ride.driverId! },
        data: {
          avgRating: newAvg,
          ratingCount: allRatings.length
        }
      });

      return { rating: createdRating, avgRating: newAvg };
    });

    res.json({ data: { success: true, rating, avgRating } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Rating error';
    res.status(500).json({ error: { code: 'RATING_ERROR', message } });
  }
});

// GET /api/rides/:id/receipt
ridesRouter.get('/:id/receipt', async (req: express.Request, res: express.Response) => {
  const rideId = String(req.params.id);
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = ((req as any).auth?.claims?.role || user.role || "RIDER").toUpperCase();

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { payment: true }
    });

    if (!ride) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ride not found' } });
    }

    // Access control: only the rider who took the ride or an ADMIN can view/download receipt
    if (ride.riderId !== user.id && role !== 'ADMIN') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not have permission to access this receipt' }
      });
    }

    const riderUser = await prisma.user.findUnique({ where: { id: ride.riderId } });
    let driverName = "Private Chauffeur";
    let vehicleModel = "Mercedes-Benz E-Class";
    let plateNumber = "DL 01 AB 1234";

    if (ride.driverId) {
      const driverUser = await prisma.user.findUnique({
        where: { id: ride.driverId },
        include: { driverProfile: true }
      });
      if (driverUser) {
        driverName = driverUser.name || driverName;
        vehicleModel = driverUser.driverProfile?.vehicleModel || vehicleModel;
        plateNumber = driverUser.driverProfile?.plateNumber || plateNumber;
      }
    }

    const fareRupees = Math.round((ride.fareFinalPaise || ride.fareEstimatePaise) / 100);
    const pdfBuffer = await generateReceiptPdf({
      id: ride.id,
      receiptNumber: `VEL-REC-${ride.id.slice(-8).toUpperCase()}`,
      date: ride.completedAt || ride.createdAt,
      riderName: riderUser?.name || 'Veloce Guest',
      driverName,
      vehicleType: ride.vehicleType,
      vehicleModel,
      plateNumber,
      pickupAddress: ride.pickupAddress,
      dropAddress: ride.dropAddress,
      distanceKm: (ride.distanceMeters / 1000).toFixed(1),
      durationMins: Math.round(ride.durationSeconds / 60),
      fareRupees,
      paymentMethod: ride.payment?.stripePaymentIntentId ? 'Credit Card (Stripe)' : 'Veloce Direct Pay',
      paymentStatus: ride.payment?.status || 'PENDING'
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="veloce-receipt-${ride.id.slice(-6)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Receipt error';
    res.status(500).json({ error: { code: 'RECEIPT_ERROR', message } });
  }
});


