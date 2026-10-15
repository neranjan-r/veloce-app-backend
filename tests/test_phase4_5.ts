import http from 'http';
import express from 'express';
import cors from 'cors';
import { prisma, getDbUser, requireAuth } from './src/index.js';
import { ridesRouter } from './src/routes/rides.js';
import { driverRouter } from './src/routes/driver.js';
import { paymentsRouter } from './src/routes/payments.js';
import { supportRouter } from './src/routes/support.js';
import { adminRouter } from './src/routes/admin.js';
import { initSockets } from './src/sockets.js';
import { seedDefaultPromos } from './src/services/promo.js';

const app = express();
app.use(cors());
app.use(express.json());

// Public emergency tracking bypasses requireAuth
app.use('/api/rides/track/:token', ridesRouter);

app.use('/api/rides', requireAuth, ridesRouter);
app.use('/api/driver', requireAuth, driverRouter);
app.use('/api/drivers', requireAuth, driverRouter);
app.use('/api/payments', requireAuth, paymentsRouter);
app.use('/api/support', requireAuth, supportRouter);
app.use('/api/admin', requireAuth, adminRouter);

const server = http.createServer(app);
initSockets(server);

const TEST_PORT = 4104;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runPhase4and5Tests() {
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`Phase 4 & 5 test server running on port ${TEST_PORT}`);

  const results: { test: string; status: 'PASS' | 'FAIL'; details: string }[] = [];

  try {
    // 0. Seed promo codes
    await seedDefaultPromos();

    const riderUser = await getDbUser("test_rider_p4", "RIDER", "Ananya Singhania");
    const driverUser = await getDbUser("test_driver_p4", "DRIVER", "Vikram Rathore");

    // 1. Multi-Stop Route Booking & Estimate
    console.log("\n--- Testing Multi-Stop Route Booking ---");
    const estimateRes = await fetch(`${BASE_URL}/api/rides/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.clerkId },
      body: JSON.stringify({
        pickup: { lat: 28.6315, lng: 77.2167 },
        drop: { lat: 28.5355, lng: 77.3910 },
        stops: [
          { lat: 28.5900, lng: 77.2300, address: "Stop 1: Lodhi Road" },
          { lat: 28.5600, lng: 77.2900, address: "Stop 2: Okhla Sanctuary" }
        ],
        vehicleType: "Veloce X"
      })
    });
    const estimateJson = await estimateRes.json();
    const estPass = estimateRes.ok && estimateJson.data?.stopsCount === 2 && estimateJson.data?.fareEstimatePaise > 0;
    results.push({
      test: "1. Multi-stop route estimation (with 2 intermediate waypoints)",
      status: estPass ? "PASS" : "FAIL",
      details: estPass ? `Estimated fare: ₹${estimateJson.data.fareEstimatePaise / 100}, stops: ${estimateJson.data.stopsCount}` : JSON.stringify(estimateJson)
    });

    // 2. Promotional Code Application
    console.log("\n--- Testing Promo Code Application (SAVE10) ---");
    const bookWithPromoRes = await fetch(`${BASE_URL}/api/rides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.clerkId },
      body: JSON.stringify({
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "Connaught Place, New Delhi",
        dropLat: 28.5355,
        dropLng: 77.3910,
        dropAddress: "Sector 18, Noida",
        stops: [
          { lat: 28.5900, lng: 77.2300, address: "Stop 1: Lodhi Road" }
        ],
        vehicleType: "Veloce X",
        promoCode: "SAVE10"
      })
    });
    const bookWithPromoJson = await bookWithPromoRes.json();
    const multiStopRide = bookWithPromoJson.data;
    const promoPass = bookWithPromoRes.ok && multiStopRide?.discountPaise > 0 && multiStopRide?.rideStops?.length === 1;
    results.push({
      test: "2. Ride booking with intermediate stops and SAVE10 promo discount",
      status: promoPass ? "PASS" : "FAIL",
      details: promoPass ? `Discount: ₹${multiStopRide.discountPaise / 100}, Stops saved: ${multiStopRide.rideStops.length}` : JSON.stringify(bookWithPromoJson)
    });

    // 3. Cancellation Fee Rules
    console.log("\n--- Testing Cancellation Fee Rules ---");
    // 3a. Cancel in REQUESTED -> fee must be 0
    const cancelReqRes = await fetch(`${BASE_URL}/api/rides/${multiStopRide.id}/cancel`, {
      method: "POST",
      headers: { "x-user-id": riderUser.clerkId }
    });
    const cancelReqJson = await cancelReqRes.json();
    const cancelReqPass = cancelReqRes.ok && cancelReqJson.data?.cancellationFeePaise === 0;
    results.push({
      test: "3a. Cancellation in REQUESTED status is free (0 fee)",
      status: cancelReqPass ? "PASS" : "FAIL",
      details: cancelReqPass ? `Fee: ₹${cancelReqJson.data.cancellationFeePaise / 100}` : JSON.stringify(cancelReqJson)
    });

    // 3b. Create new ride, accept it, but cancel after >2 mins
    const rideToAccept = await prisma.ride.create({
      data: {
        riderId: riderUser.id,
        driverId: driverUser.id,
        vehicleType: "Veloce X",
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "Aerocity",
        dropLat: 28.5355,
        dropLng: 77.3910,
        dropAddress: "CyberHub",
        distanceMeters: 12000,
        durationSeconds: 1500,
        fareEstimatePaise: 85000,
        status: "ACCEPTED",
        acceptedAt: new Date(Date.now() - 5 * 60 * 1000) // 5 minutes ago (>2 mins limit)
      }
    });

    const cancelAcceptedRes = await fetch(`${BASE_URL}/api/rides/${rideToAccept.id}/cancel`, {
      method: "POST",
      headers: { "x-user-id": riderUser.clerkId }
    });
    const cancelAcceptedJson = await cancelAcceptedRes.json();
    const cancelFeePass = cancelAcceptedRes.ok && cancelAcceptedJson.data?.cancellationFeePaise === 2000;
    results.push({
      test: "3b. Cancellation >2 mins after assignment incurs 2000 paise (₹20) fee",
      status: cancelFeePass ? "PASS" : "FAIL",
      details: cancelFeePass ? `Applied cancellation fee: ₹${cancelAcceptedJson.data.cancellationFeePaise / 100}` : JSON.stringify(cancelAcceptedJson)
    });

    // 4. SOS Emergency Beacon & Public Tracking Link
    console.log("\n--- Testing SOS Emergency Beacon ---");
    const activeRide = await prisma.ride.create({
      data: {
        riderId: riderUser.id,
        driverId: driverUser.id,
        vehicleType: "Veloce X",
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "The Oberoi, New Delhi",
        dropLat: 28.5355,
        dropLng: 77.3910,
        dropAddress: "Indira Gandhi Airport T3",
        distanceMeters: 18000,
        durationSeconds: 2200,
        fareEstimatePaise: 125000,
        status: "IN_PROGRESS"
      }
    });

    const sosRes = await fetch(`${BASE_URL}/api/rides/${activeRide.id}/sos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.clerkId },
      body: JSON.stringify({ lat: 28.6100, lng: 77.2200 })
    });
    const sosJson = await sosRes.json();
    const token = sosJson.data?.trackingToken;
    const sosPass = sosRes.ok && sosJson.data?.success && !!token;
    results.push({
      test: "4a. Trigger SOS Beacon & Generate 12-Hour Signed Token",
      status: sosPass ? "PASS" : "FAIL",
      details: sosPass ? `Token: ${token.slice(0, 20)}..., TrackingUrl: ${sosJson.data.trackingUrl}` : JSON.stringify(sosJson)
    });

    // 4b. Test Public Tracking Endpoint (NO auth header!)
    const trackRes = await fetch(`${BASE_URL}/api/rides/track/${token}`);
    const trackJson = await trackRes.json();
    const trackPass = trackRes.ok && trackJson.data?.sosActive === true && trackJson.data?.ride?.id === activeRide.id;
    results.push({
      test: "4b. Public emergency tracking endpoint verifies token without login",
      status: trackPass ? "PASS" : "FAIL",
      details: trackPass ? `Ride: ${trackJson.data.ride.id}, SOS Active: ${trackJson.data.sosActive}` : JSON.stringify(trackJson)
    });

    // 5. Support Tickets Desk
    console.log("\n--- Testing Support Desk ---");
    const createTicketRes = await fetch(`${BASE_URL}/api/support/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.clerkId },
      body: JSON.stringify({
        category: "Chauffeur Feedback",
        message: "Chauffeur offered premium sparkling water and arrived early.",
        rideId: activeRide.id
      })
    });
    const createTicketJson = await createTicketRes.json();
    const ticketId = createTicketJson.data?.id;

    // Resolve ticket
    const replyTicketRes = await fetch(`${BASE_URL}/api/support/tickets/${ticketId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": "admin_user", "x-role": "ADMIN" },
      body: JSON.stringify({
        adminReply: "Thank you for the compliment. We have noted this on Chauffeur Vikram's record."
      })
    });
    const replyTicketJson = await replyTicketRes.json();
    const ticketPass = replyTicketRes.ok && replyTicketJson.data?.status === "RESOLVED" && !!replyTicketJson.data?.adminReply;
    results.push({
      test: "5. Customer support ticket logged and resolved with executive reply",
      status: ticketPass ? "PASS" : "FAIL",
      details: ticketPass ? `Status: ${replyTicketJson.data.status}, Reply: "${replyTicketJson.data.adminReply.slice(0, 30)}..."` : JSON.stringify(replyTicketJson)
    });

    // 6. Executive Admin Endpoints & Security Guard
    console.log("\n--- Testing Admin Role Guards & Stats ---");
    // 6a. Non-admin request rejected
    const forbiddenRes = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { "x-user-id": riderUser.clerkId, "x-role": "RIDER" }
    });
    const forbiddenPass = forbiddenRes.status === 403;
    results.push({
      test: "6a. Non-admin user blocked from /api/admin/* (HTTP 403 FORBIDDEN)",
      status: forbiddenPass ? "PASS" : "FAIL",
      details: `HTTP Status: ${forbiddenRes.status}`
    });

    // 6b. Admin request authorized
    const adminStatsRes = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { "x-user-id": "executive_admin", "x-role": "ADMIN" }
    });
    const adminStatsJson = await adminStatsRes.json();
    const adminPass = adminStatsRes.ok && typeof adminStatsJson.data?.totalRevenueRupees === "number";
    results.push({
      test: "6b. Admin KPI stats accessible with ADMIN role",
      status: adminPass ? "PASS" : "FAIL",
      details: adminPass ? `Total Rides: ${adminStatsJson.data.totalRides}, Revenue: ₹${adminStatsJson.data.totalRevenueRupees}` : JSON.stringify(adminStatsJson)
    });

    // 6c. Resolve SOS via Admin
    const sosEventsRes = await fetch(`${BASE_URL}/api/admin/sos`, {
      headers: { "x-user-id": "executive_admin", "x-role": "ADMIN" }
    });
    const sosEventsJson = await sosEventsRes.json();
    const sosEventToResolve = sosEventsJson.data?.find((s: any) => !s.resolved);
    if (sosEventToResolve) {
      const resolveRes = await fetch(`${BASE_URL}/api/admin/sos/${sosEventToResolve.id}/resolve`, {
        method: "POST",
        headers: { "x-user-id": "executive_admin", "x-role": "ADMIN" }
      });
      const resolveJson = await resolveRes.json();
      const resolvePass = resolveRes.ok && resolveJson.data?.resolved === true;
      results.push({
        test: "6c. Admin resolves SOS emergency beacon successfully",
        status: resolvePass ? "PASS" : "FAIL",
        details: resolvePass ? `SOS Event ${sosEventToResolve.id} resolved: true` : JSON.stringify(resolveJson)
      });
    }

  } catch (err: any) {
    console.error("Test execution failure:", err);
    results.push({
      test: "FATAL_ERROR",
      status: "FAIL",
      details: err.message
    });
  } finally {
    console.log("\n=================== PHASE 4 & 5 TEST RESULTS ===================");
    console.table(results);
    server.close();
    process.exit(results.every(r => r.status === "PASS") ? 0 : 1);
  }
}

runPhase4and5Tests().catch(err => {
  console.error("Runner error:", err);
  process.exit(1);
});
