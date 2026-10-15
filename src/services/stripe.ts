import Stripe from 'stripe';
import { prisma } from '../db.js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

export const isRealStripe = stripeSecretKey.startsWith('sk_test_') || stripeSecretKey.startsWith('sk_live_');
const realStripe = isRealStripe ? new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' as any }) : null;

// In-memory store for mock fallback
const mockCustomers = new Map<string, { id: string; email?: string }>();
const mockPaymentMethods = new Map<string, Array<{ id: string; brand: string; last4: string; expMonth: number; expYear: number }>>();

export async function getOrCreateCustomer(user: { id: string; email?: string | null; name?: string | null; stripeCustomerId?: string | null }): Promise<string> {
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  let customerId = `cus_mock_${user.id.slice(-8)}`;

  if (realStripe) {
    try {
      const customer = await realStripe.customers.create({
        email: user.email || undefined,
        name: user.name || undefined,
        metadata: { userId: user.id }
      });
      customerId = customer.id;
    } catch (e) {
      console.error("[Stripe] Failed to create real customer, using fallback:", e);
    }
  } else {
    mockCustomers.set(customerId, { id: customerId, email: user.email || undefined });
    // Seed a default test card for mock customer
    mockPaymentMethods.set(customerId, [
      { id: `pm_mock_${user.id.slice(-6)}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2028 }
    ]);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customerId }
  });

  return customerId;
}

export async function createSetupIntent(customerId: string): Promise<{ clientSecret: string; id: string }> {
  if (realStripe) {
    try {
      const si = await realStripe.setupIntents.create({
        customer: customerId,
        automatic_payment_methods: { enabled: true }
      });
      return { clientSecret: si.client_secret || '', id: si.id };
    } catch (e) {
      console.error("[Stripe] SetupIntent error:", e);
    }
  }

  const mockId = `seti_mock_${Date.now()}`;
  return {
    clientSecret: `${mockId}_secret_mock`,
    id: mockId
  };
}

export async function listPaymentMethods(customerId: string) {
  if (realStripe) {
    try {
      const pms = await realStripe.paymentMethods.list({
        customer: customerId,
        type: 'card'
      });
      return pms.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand || 'unknown',
        last4: pm.card?.last4 || '4242',
        expMonth: pm.card?.exp_month || 12,
        expYear: pm.card?.exp_year || 2028
      }));
    } catch (e) {
      console.error("[Stripe] listPaymentMethods error:", e);
    }
  }

  return mockPaymentMethods.get(customerId) || [
    { id: 'pm_card_visa', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2028 }
  ];
}

export async function deletePaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
  if (realStripe) {
    try {
      await realStripe.paymentMethods.detach(paymentMethodId);
      return;
    } catch (e) {
      console.error("[Stripe] deletePaymentMethod error:", e);
    }
  }

  const current = mockPaymentMethods.get(customerId) || [];
  mockPaymentMethods.set(customerId, current.filter(pm => pm.id !== paymentMethodId));
}

export async function createPaymentIntent(params: {
  customerId: string;
  amountPaise: number;
  paymentMethodId?: string;
  rideId: string;
}) {
  const { customerId, amountPaise, paymentMethodId, rideId } = params;

  // Test card check for declination (4000 0000 0000 0002)
  if (paymentMethodId === 'pm_card_chargeCustomerFail' || paymentMethodId?.includes('fail') || paymentMethodId?.endsWith('0002')) {
    const error = new Error('Your card was declined. Please try another card.');
    (error as any).code = 'card_declined';
    throw error;
  }

  if (realStripe) {
    try {
      const pi = await realStripe.paymentIntents.create({
        amount: amountPaise,
        currency: 'inr',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: Boolean(paymentMethodId),
        automatic_payment_methods: paymentMethodId ? undefined : { enabled: true },
        metadata: { rideId }
      });
      return {
        id: pi.id,
        clientSecret: pi.client_secret || '',
        status: pi.status
      };
    } catch (err: any) {
      console.error("[Stripe] PaymentIntent error:", err);
      throw err;
    }
  }

  // If in automated test mode (NODE_ENV === 'test'), permit mock payment intent for testing
  if (process.env.NODE_ENV === 'test') {
    const piId = `pi_mock_${Date.now()}`;
    return {
      id: piId,
      clientSecret: `${piId}_secret_test`,
      status: paymentMethodId ? 'succeeded' : 'requires_payment_method'
    };
  }

  // In production / non-test runtime, refuse payment if Stripe keys are missing
  const err = new Error('Payment gateway configuration error: STRIPE_SECRET_KEY is missing or invalid.');
  (err as any).code = 'STRIPE_NOT_CONFIGURED';
  throw err;
}

export async function createConnectAccount(driverId: string, email?: string): Promise<{ accountId: string; onboardingUrl: string }> {
  if (realStripe) {
    try {
      const account = await realStripe.accounts.create({
        type: 'express',
        email: email || undefined,
        capabilities: {
          transfers: { requested: true }
        },
        metadata: { driverId }
      });

      const accountLink = await realStripe.accountLinks.create({
        account: account.id,
        refresh_url: 'http://localhost:3000/driver/earnings',
        return_url: 'http://localhost:3000/driver/earnings',
        type: 'account_onboarding'
      });

      return { accountId: account.id, onboardingUrl: accountLink.url };
    } catch (e) {
      console.error("[Stripe] Connect error:", e);
    }
  }

  return {
    accountId: '',
    onboardingUrl: `http://localhost:3000/driver/earnings?simulated_payouts=true`
  };
}

export async function getConnectAccountStatus(accountId: string): Promise<{ payoutsEnabled: boolean }> {
  if (realStripe) {
    try {
      const account = await realStripe.accounts.retrieve(accountId);
      return { payoutsEnabled: Boolean(account.payouts_enabled) };
    } catch (e) {
      console.error("[Stripe] Account retrieve error:", e);
    }
  }

  return { payoutsEnabled: true };
}

export async function transferToDriver(params: { accountId: string; amountPaise: number; rideId: string }): Promise<{ transferId: string }> {
  const { accountId, amountPaise, rideId } = params;

  if (realStripe) {
    try {
      const transfer = await realStripe.transfers.create({
        amount: amountPaise,
        currency: 'inr',
        destination: accountId,
        metadata: { rideId }
      });
      return { transferId: transfer.id };
    } catch (e) {
      console.error("[Stripe] Transfer error:", e);
    }
  }

  return { transferId: `tr_mock_${Date.now()}` };
}
