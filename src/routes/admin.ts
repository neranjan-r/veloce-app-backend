import express from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireRole } from '../middleware/auth.js';

export const adminRouter = express.Router();

adminRouter.use(requireRole('ADMIN'));

// GET /api/admin/stats - Executive KPIs & real-time counts
adminRouter.get('/stats', async (req: express.Request, res: express.Response) => {
  try {
    const [
      totalRides,
      completedRides,
      activeDrivers,
      openTickets,
      activeSos
    ] = await Promise.all([
      prisma.ride.count(),
      prisma.ride.count({ where: { status: 'COMPLETED' } }),
      prisma.driverProfile.count({ where: { isOnline: true } }),
      prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      prisma.sosEvent.count({ where: { resolved: false } })
    ]);

    // Sum revenue for completed journeys
    const completedList = await prisma.ride.findMany({
      where: { status: 'COMPLETED' },
      select: { fareFinalPaise: true, fareEstimatePaise: true }
    });

    const totalRevenuePaise = completedList.reduce((acc, r) => acc + (r.fareFinalPaise || r.fareEstimatePaise || 0), 0);

    res.json({
      data: {
        totalRides,
        completedRides,
        activeDrivers,
        openTickets,
        activeSos,
        totalRevenuePaise,
        totalRevenueRupees: Math.round(totalRevenuePaise / 100)
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch admin stats';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// GET /api/admin/rides - Detailed dispatches & journeys
adminRouter.get('/rides', async (req: express.Request, res: express.Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string, 10) || 20));
    const status = req.query.status as string;

    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = status;
    }

    const [totalCount, rides] = await Promise.all([
      prisma.ride.count({ where }),
      prisma.ride.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          rideStops: true,
          payment: true,
          rating: true
        }
      })
    ]);

    res.json({
      data: {
        rides,
        pagination: {
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
          totalCount
        }
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch admin rides';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// GET /api/admin/users - User accounts & chauffeurs
adminRouter.get('/users', async (req: express.Request, res: express.Response) => {
  try {
    const users = await prisma.user.findMany({
      include: { driverProfile: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json({ data: users });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch users';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// GET /api/admin/sos - Real-time and historical SOS emergencies
adminRouter.get('/sos', async (req: express.Request, res: express.Response) => {
  try {
    const sosEvents = await prisma.sosEvent.findMany({
      orderBy: { createdAt: 'desc' }
    });

    res.json({ data: sosEvents });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch SOS events';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// POST /api/admin/sos/:id/resolve - Clear emergency alert
adminRouter.post('/sos/:id/resolve', async (req: express.Request, res: express.Response) => {
  const sosId = String(req.params.id);
  try {
    const updated = await prisma.sosEvent.update({
      where: { id: sosId },
      data: { resolved: true }
    });

    res.json({ data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to resolve SOS event';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// GET /api/admin/tickets - Support inquiries
adminRouter.get('/tickets', async (req: express.Request, res: express.Response) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      orderBy: { createdAt: 'desc' }
    });

    res.json({ data: tickets });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch tickets';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// Promo codes schema
const promoCodeSchema = z.object({
  code: z.string().min(3),
  percentOff: z.number().min(1).max(100).optional(),
  flatOffPaise: z.number().min(100).optional(),
  maxUses: z.number().min(1).default(100),
  expiresAt: z.string().optional()
});

// POST /api/admin/promos - Create marketing incentive
adminRouter.post('/promos', async (req: express.Request, res: express.Response) => {
  const parseResult = promoCodeSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: parseResult.error.issues.map(i => i.message).join(', ')
      }
    });
  }

  const { code, percentOff, flatOffPaise, maxUses, expiresAt } = parseResult.data;

  try {
    const promo = await prisma.promoCode.create({
      data: {
        code: code.trim().toUpperCase(),
        percentOff: percentOff ?? null,
        flatOffPaise: flatOffPaise ?? null,
        maxUses,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        active: true
      }
    });

    res.json({ data: promo });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create promo code';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});

// GET /api/admin/promos - List promotional codes
adminRouter.get('/promos', async (req: express.Request, res: express.Response) => {
  try {
    const promos = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' }
    });

    res.json({ data: promos });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to list promo codes';
    res.status(500).json({ error: { code: 'ADMIN_ERROR', message: msg } });
  }
});
