import express from 'express';
import { prisma } from '../db.js';
import { getOrCreateCustomer, createSetupIntent, listPaymentMethods, deletePaymentMethod } from '../services/stripe.js';

export const paymentsRouter = express.Router();

// POST /api/payments/setup-intent
paymentsRouter.post('/setup-intent', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const customerId = await getOrCreateCustomer(user);

    const setupIntent = await createSetupIntent(customerId);
    res.json({ data: setupIntent });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'SETUP_INTENT_ERROR', message } });
  }
});

// GET /api/payments/methods
paymentsRouter.get('/methods', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const customerId = await getOrCreateCustomer(user);

    const methods = await listPaymentMethods(customerId);
    res.json({ data: methods });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'PAYMENT_METHODS_ERROR', message } });
  }
});

// DELETE /api/payments/methods/:id
paymentsRouter.delete('/methods/:id', async (req: express.Request, res: express.Response) => {
  try {
    const user = (req as any).auth?.user;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const customerId = await getOrCreateCustomer(user);
    const methodId = String(req.params.id);

    await deletePaymentMethod(customerId, methodId);
    res.json({ data: { success: true } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'DELETE_PAYMENT_METHOD_ERROR', message } });
  }
});
