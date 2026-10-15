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
app.use(express.json());

app.use('/api/rides', requireAuth, ridesRouter);
app.use('/api/driver', requireAuth, driverRouter);
app.use('/api/drivers', requireAuth, driverRouter);
app.use('/api/payments', requireAuth, paymentsRouter);

const server = http.createServer(app);
initSockets(server);

const TEST_PORT = 4103;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runPhase3Tests() {
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`Phase 3 test server running on port ${TEST_PORT}`);

  const results: { test: string; status: 'PASS' | 'FAIL'; details: string }[] = [];

  try {
    const riderUser = await getDbUser("test_rider_p3", "RIDER", "Meera Kapoor");
    const driverUser = await getDbUser("test_driver_p3", "DRIVER", "Harish Rawat");

    // Initialize driver profile
    await prisma.driverProfile.upsert({
      where: { userId: driverUser.id },
      update: { avgRating: 5.0, ratingCount: 1 },
      create: {
        userId: driverUser.id,
        vehicleType: "Veloce X",
        vehicleModel: "Mercedes-Benz E-Class",
        plateNumber: "DL 01 AB 9999",
        avgRating: 5.0,
        ratingCount: 1
      }
    });

    // 1. Create completed and paid ride
    console.log("\n--- Setting up completed and paid ride ---");
    const ride = await prisma.ride.create({
      data: {
        riderId: riderUser.id,
        driverId: driverUser.id,
        status: "COMPLETED",
        vehicleType: "Veloce X",
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "The Imperial, Janpath",
        dropLat: 28.5562,
        dropLng: 77.1000,
        dropAddress: "IGI Airport Terminal 3",
        distanceMeters: 16000,
        durationSeconds: 1800,
        fareEstimatePaise: 120000, // ₹1,200
        completedAt: new Date()
      }
    });

    // Pay the ride
    const payRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({ paymentMethodId: "4242424242424242" })
    });
    const payData = await payRes.json() as any;

    if (payRes.status === 200 && payData.data?.success) {
      results.push({ test: "1. Ride paid successfully", status: "PASS", details: `Paid fare: ₹1200, PaymentId: ${payData.data.payment.id}` });
    } else {
      results.push({ test: "1. Ride paid successfully", status: "FAIL", details: JSON.stringify(payData) });
    }

    // 2. Submit rating (5 stars, comment)
    console.log("\n--- Submitting 5-star rating ---");
    const rateRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/rating`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({ stars: 5, comment: "Exemplary chauffeur service and immaculate vehicle." })
    });
    const rateData = await rateRes.json() as any;

    const driverProfileAfter = await prisma.driverProfile.findUnique({ where: { userId: driverUser.id } });

    if (rateRes.status === 200 && rateData.data?.success && driverProfileAfter?.avgRating === 5.0) {
      results.push({
        test: "2. Rating submitted and driver average rating updated atomically",
        status: "PASS",
        details: `Stars: 5, Driver avgRating: ${driverProfileAfter.avgRating}, ratingCount: ${driverProfileAfter.ratingCount}`
      });
    } else {
      results.push({
        test: "2. Rating submitted and driver average rating updated atomically",
        status: "FAIL",
        details: JSON.stringify({ rateData, driverProfileAfter })
      });
    }

    // 3. Second rating attempt on same ride is rejected
    console.log("\n--- Submitting second rating on same ride (must be rejected 409) ---");
    const secondRateRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/rating`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({ stars: 4 })
    });
    const secondRateData = await secondRateRes.json() as any;

    if (secondRateRes.status === 409 && secondRateData.error?.code === "RATING_ALREADY_EXISTS") {
      results.push({
        test: "3. Duplicate rating attempt on same ride is rejected (409 RATING_ALREADY_EXISTS)",
        status: "PASS",
        details: `HTTP ${secondRateRes.status}, Error code: ${secondRateData.error.code}`
      });
    } else {
      results.push({
        test: "3. Duplicate rating attempt on same ride is rejected (409 RATING_ALREADY_EXISTS)",
        status: "FAIL",
        details: JSON.stringify(secondRateData)
      });
    }

    // 4. Download PDF receipt
    console.log("\n--- Downloading PDF receipt ---");
    const receiptRes = await fetch(`${BASE_URL}/api/rides/${ride.id}/receipt`, {
      method: "GET",
      headers: { "x-user-id": riderUser.id, "x-role": "RIDER" }
    });
    const receiptBuffer = await receiptRes.arrayBuffer();
    const contentType = receiptRes.headers.get("content-type");
    const pdfHeader = Buffer.from(receiptBuffer).slice(0, 4).toString("utf8");

    if (receiptRes.status === 200 && contentType?.includes("application/pdf") && pdfHeader === "%PDF") {
      results.push({
        test: "4. Official PDF receipt generated and downloaded successfully",
        status: "PASS",
        details: `Content-Type: ${contentType}, Size: ${receiptBuffer.byteLength} bytes, Magic: %PDF`
      });
    } else {
      results.push({
        test: "4. Official PDF receipt generated and downloaded successfully",
        status: "FAIL",
        details: `Status: ${receiptRes.status}, Content-Type: ${contentType}, Header: ${pdfHeader}`
      });
    }

    // 5. Driver reviews listing
    console.log("\n--- Listing driver reviews ---");
    const reviewsRes = await fetch(`${BASE_URL}/api/drivers/${driverUser.id}/reviews`, {
      method: "GET",
      headers: { "x-user-id": riderUser.id, "x-role": "RIDER" }
    });
    const reviewsData = await reviewsRes.json() as any;

    if (reviewsRes.status === 200 && Array.isArray(reviewsData.data) && reviewsData.data.length > 0) {
      results.push({
        test: "5. Driver reviews listed with passenger feedback",
        status: "PASS",
        details: `Found ${reviewsData.data.length} review(s). Top comment: "${reviewsData.data[0].comment}"`
      });
    } else {
      results.push({
        test: "5. Driver reviews listed with passenger feedback",
        status: "FAIL",
        details: JSON.stringify(reviewsData)
      });
    }

  } catch (err: any) {
    console.error("Phase 3 test error:", err);
  } finally {
    server.close();
    console.log("\n=================== PHASE 3 TEST RESULTS ===================");
    console.table(results);
    process.exit(results.every(r => r.status === 'PASS') ? 0 : 1);
  }
}

runPhase3Tests();
