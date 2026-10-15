import express from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireRole } from '../middleware/auth.js';

export const supportRouter = express.Router();

const createTicketSchema = z.object({
  category: z.string().min(1, 'Category is required'),
  message: z.string().min(1, 'Message is required'),
  rideId: z.string().optional(),
});

const replyTicketSchema = z.object({
  adminReply: z.string().min(1, 'Reply message is required'),
  status: z.string().optional().default('RESOLVED'),
});

// POST /api/support/tickets - Submit a support ticket
supportRouter.post('/tickets', async (req: express.Request, res: express.Response) => {
  const parseResult = createTicketSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: parseResult.error.issues.map(i => i.message).join(', ')
      }
    });
  }

  const { category, message, rideId } = parseResult.data;

  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: user.id,
        category,
        message,
        rideId,
        status: 'OPEN'
      }
    });

    res.json({ data: ticket });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create ticket';
    res.status(500).json({ error: { code: 'SUPPORT_ERROR', message: msg } });
  }
});

// GET /api/support/tickets - Get user's tickets (or all if admin)
supportRouter.get('/tickets', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const userRole = ((req as any).auth?.claims?.role || user.role || 'RIDER').toUpperCase();

    const whereClause = userRole === 'ADMIN' ? {} : { userId: user.id };

    const tickets = await prisma.supportTicket.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });

    res.json({ data: tickets });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch tickets';
    res.status(500).json({ error: { code: 'SUPPORT_ERROR', message: msg } });
  }
});

// POST /api/support/tickets/:id/reply - Reply to a ticket (admin only)
supportRouter.post('/tickets/:id/reply', requireRole('ADMIN'), async (req: express.Request, res: express.Response) => {
  const ticketId = String(req.params.id);
  const parseResult = replyTicketSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: parseResult.error.issues.map(i => i.message).join(', ')
      }
    });
  }

  const { adminReply, status } = parseResult.data;

  try {
    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        adminReply,
        status: status || 'RESOLVED'
      }
    });

    res.json({ data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update ticket';
    res.status(500).json({ error: { code: 'SUPPORT_ERROR', message: msg } });
  }
});
