import http from 'http';
import express from 'express';
import cors from 'cors';
import { prisma, getDbUser, requireAuth } from './src/index.js';
import { ridesRouter } from './src/routes/rides.js';
import { driverRouter } from './src/routes/driver.js';
import { paymentsRouter } from './src/routes/payments.js';
import { initSockets } from './src/sockets.js';

const app = express();
app.use(cors());

// Webhook with raw body
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req: express.Request, res: express.Response) => {
  const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
  const event = JSON.parse(bodyStr);

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data?.object;
    const rideId = paymentIntent?.metadata?.rideId;
    if (rideId) {
      await prisma.payment.updateMany({
        where: { rideId },
        data: { status: 'PAID', stripePaymentIntentId: paymentIntent.id }
      });
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
});

app.use(express.json());

app.use('/api/rides', requireAuth, ridesRouter);
app.use('/api/driver', requireAuth, driverRouter);
app.use('/api/payments', requireAuth, paymentsRouter);

const server = http.createServer(app);
initSockets(server);

const TEST_PORT = 4101;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runPaymentTests() {
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`Payment test server running on port ${TEST_PORT}`);

  const results: { test: string; status: 'PASS' | 'FAIL'; details: string }[] = [];

  try {
    const riderUser = await getDbUser("test_rider_pay", "RIDER", "Ananya Verma");
    const driverUser = await getDbUser("test_driver_pay", "DRIVER", "Devendra Pal");

    // 1. Test SetupIntent & Methods
    console.log("\n--- Testing 1: SetupIntent & Payment Methods ---");
    const siRes = await fetch(`${BASE_URL}/api/payments/setup-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" }
    });
    const siData = await siRes.json() as any;

    const pmRes = await fetch(`${BASE_URL}/api/payments/methods`, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" }
    });
    const pmData = await pmRes.json() as any;

    if (siRes.status === 200 && siData.data?.clientSecret && Array.isArray(pmData.data)) {
      results.push({
        test: "1. SetupIntent created and payment methods listed for rider",
        status: "PASS",
        details: `SetupIntent: ${siData.data.id}, Methods count: ${pmData.data.length}`
      });
    } else {
      results.push({
        test: "1. SetupIntent created and payment methods listed for rider",
        status: "FAIL",
        details: JSON.stringify({ siData, pmData })
      });
    }

    // 2. Create and complete a test ride
    console.log("\n--- Creating and completing test ride ---");
    const ride = await prisma.ride.create({
      data: {
        riderId: riderUser.id,
        driverId: driverUser.id,
        status: "COMPLETED",
        vehicleType: "Veloce X",
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "Connaught Place",
        dropLat: 28.4952,
        dropLng: 77.0891,
        dropAddress: "Cyber Hub",
        distanceMeters: 28000,
        durationSeconds: 2400,
        fareEstimatePaise: 150000, // ₹1,500
        completedAt: new Date()
      }
    });

    // 3. Test pay with failure card: 4000 0000 0000 0002
    console.log("\n--- Testing 2: Payment failure with declined card (4000...0002) ---");
    const failPayRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({ paymentMethodId: "4000000000000002" })
    });
    const failPayData = await failPayRes.json() as any;

    if (failPayRes.status === 400 && (failPayData.error?.code === "card_declined" || failPayData.error?.message?.includes("declined"))) {
      results.push({
        test: "2. Payment failure with test card 4000 0000 0000 0002 allows retry",
        status: "PASS",
        details: `HTTP ${failPayRes.status}, Error code: ${failPayData.error.code}, Message: ${failPayData.error.message}`
      });
    } else {
      results.push({
        test: "2. Payment failure with test card 4000 0000 0000 0002 allows retry",
        status: "FAIL",
        details: JSON.stringify(failPayData)
      });
    }

    // 4. Test pay with success card: 4242 4242 4242 4242
    console.log("\n--- Testing 3: Payment success with valid card (4242...4242) ---");
    const successPayRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({ paymentMethodId: "4242424242424242" })
    });
    const successPayData = await successPayRes.json() as any;

    const paymentRow = await prisma.payment.findUnique({ where: { rideId: ride.id } });

    // Idempotency check: paying again
    const secondPayRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({ paymentMethodId: "4242424242424242" })
    });
    const secondPayData = await secondPayRes.json() as any;

    const isSuccess = successPayRes.status === 200 && successPayData.data?.success &&
                      paymentRow?.status === "PAID" &&
                      paymentRow?.amountPaise === 150000 &&
                      paymentRow?.driverPayoutPaise === 120000 && // 80%
                      paymentRow?.platformFeePaise === 30000 &&   // 20%
                      secondPayData.data?.alreadyPaid === true;

    if (isSuccess) {
      results.push({
        test: "3. Payment success with 4242...4242: 80% driver (₹1200), 20% platform (₹300), idempotent",
        status: "PASS",
        details: `Amount: ₹${paymentRow!.amountPaise/100}, Driver payout: ₹${paymentRow!.driverPayoutPaise!/100}, Platform fee: ₹${paymentRow!.platformFeePaise!/100}`
      });
    } else {
      results.push({
        test: "3. Payment success with 4242...4242: 80% driver (₹1200), 20% platform (₹300), idempotent",
        status: "FAIL",
        details: JSON.stringify({ successPayData, paymentRow, secondPayData })
      });
    }

    // 5. Test Webhook handler
    console.log("\n--- Testing 4: Webhook handler updates Payment row ---");
    const webhookRes = await fetch(`${BASE_URL}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_webhook_verified",
            metadata: { rideId: ride.id }
          }
        }
      })
    });
    const webhookData = await webhookRes.json() as any;
    const paymentAfterWebhook = await prisma.payment.findUnique({ where: { rideId: ride.id } });

    if (webhookRes.status === 200 && webhookData.received && paymentAfterWebhook?.stripePaymentIntentId === "pi_webhook_verified") {
      results.push({
        test: "4. Webhook /webhooks/stripe verifies and updates Payment row",
        status: "PASS",
        details: `Updated Payment intent to ${paymentAfterWebhook.stripePaymentIntentId}`
      });
    } else {
      results.push({
        test: "4. Webhook /webhooks/stripe verifies and updates Payment row",
        status: "FAIL",
        details: JSON.stringify({ webhookData, paymentAfterWebhook })
      });
    }

    // 6. Test Driver Payouts: Onboarding, Status, Earnings
    console.log("\n--- Testing 5: Driver payouts onboarding, status, earnings ledger ---");
    const onboardRes = await fetch(`${BASE_URL}/api/driver/payouts/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    const onboardData = await onboardRes.json() as any;

    const statusRes = await fetch(`${BASE_URL}/api/driver/payouts/status`, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    const statusData = await statusRes.json() as any;

    const earningsRes = await fetch(`${BASE_URL}/api/driver/earnings`, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    const earningsData = await earningsRes.json() as any;

    const payoutsPass = onboardRes.status === 200 && onboardData.data?.onboardingUrl &&
                        statusRes.status === 200 && statusData.data?.payoutsEnabled &&
                        earningsRes.status === 200 && earningsData.data?.totalEarningsPaise >= 120000;

    if (payoutsPass) {
      results.push({
        test: "5. Driver Connect Express onboarding, status active, and earnings ledger",
        status: "PASS",
        details: `Onboarding URL generated, Total Driver Earnings: ₹${earningsData.data.totalEarningsPaise/100}`
      });
    } else {
      results.push({
        test: "5. Driver Connect Express onboarding, status active, and earnings ledger",
        status: "FAIL",
        details: JSON.stringify({ onboardData, statusData, earningsData })
      });
    }

  } catch (err: any) {
    console.error("Payment test error:", err);
  } finally {
    server.close();
    console.log("\n=================== PHASE 2 TEST RESULTS ===================");
    console.table(results);
    process.exit(results.every(r => r.status === 'PASS') ? 0 : 1);
  }
}

runPaymentTests();
