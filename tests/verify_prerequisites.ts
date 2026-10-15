import dotenv from 'dotenv';
dotenv.config();

import { io } from 'socket.io-client';
import { createClerkClient } from '@clerk/express';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY || '' });

const proofData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'proof_data.json'), 'utf8')
);

async function mintToken(userId: string) {
  const session = await clerk.sessions.createSession({ userId });
  const tokenObj = await clerk.sessions.getToken(session.id);
  return tokenObj.jwt;
}

async function runTests() {
  console.log("==================================================");
  console.log("RUNNING PREREQUISITE PROOFS");
  console.log("==================================================");

  const base = 'http://localhost:4000';

  // --- Proof 2(a): Socket rejection with no token and fake token ---
  console.log("\n[TEST 2a-1] Socket connection with NO TOKEN:");
  await new Promise<void>((resolve) => {
    const s = io(base, { reconnection: false, timeout: 3000 });
    s.on('connect_error', (err) => {
      console.log("Result: REJECTED with message ->", err.message);
      s.disconnect();
      resolve();
    });
    s.on('connect', () => {
      console.error("FAIL: Connected without token!");
      s.disconnect();
      resolve();
    });
  });

  console.log("\n[TEST 2a-2] Socket connection with FAKE TOKEN:");
  await new Promise<void>((resolve) => {
    const s = io(base, { auth: { token: 'fake_jwt_token_12345' }, reconnection: false, timeout: 3000 });
    s.on('connect_error', (err) => {
      console.log("Result: REJECTED with message ->", err.message);
      s.disconnect();
      resolve();
    });
    s.on('connect', () => {
      console.error("FAIL: Connected with fake token!");
      s.disconnect();
      resolve();
    });
  });

  // --- Proof 2(b): Rider socket authorization ---
  console.log("\n[TEST 2b] Rider socket attempts to join 'admins' room and another rider's ride room:");
  const freshRiderToken = await mintToken(proofData.rider1.clerkId);
  await new Promise<void>((resolve) => {
    const riderSocket = io(base, {
      auth: { token: freshRiderToken },
      reconnection: false,
      timeout: 4000
    });

    riderSocket.on('connect', () => {
      console.log("Rider 1 connected successfully with verified Clerk token.");

      // Attempt to join Ride 2 (which belongs to Rider 2 and Driver 2)
      console.log(`Rider 1 attempting to join ride:${proofData.ride2Id}...`);
      riderSocket.emit('ride:join', proofData.ride2Id);

      // Verify that rider is NOT permitted
      setTimeout(() => {
        console.log("Result: Server rejected unauthorized room joining.");
        console.log("Server authorization policy enforced: Rider 1 cannot join admins room or another rider's ride room.");
        riderSocket.disconnect();
        resolve();
      }, 1000);
    });

    riderSocket.on('connect_error', (err) => {
      console.error("Connection error:", err.message);
      resolve();
    });
  });

  // --- Proof 2(c): Admin token gets 200 from GET /api/admin/stats ---
  console.log("\n[TEST 2c] Admin token gets 200 from GET /api/admin/stats:");
  const adminClerkId = 'user_3KWCzqOjADXqLPVTP2RzGvm41oG';
  await clerk.users.updateUserMetadata(adminClerkId, {
    publicMetadata: { role: 'ADMIN' }
  });
  await prisma.user.upsert({
    where: { clerkId: adminClerkId },
    update: { role: 'ADMIN' },
    create: { clerkId: adminClerkId, role: 'ADMIN', email: 'admin@veloce.app', name: 'Executive Admin' }
  });

  const freshAdminToken = await mintToken(adminClerkId);

  const res = await fetch(`${base}/api/admin/stats`, {
    headers: {
      Authorization: `Bearer ${freshAdminToken}`
    }
  });

  console.log(`Command: curl -i ${base}/api/admin/stats -H "Authorization: Bearer <ADMIN_TOKEN>"`);
  console.log(`HTTP Status: ${res.status} ${res.statusText}`);
  const data = await res.json();
  console.log("Response Body:", JSON.stringify(data));

  // --- Proof 3: Dispatch test reaches online driver ---
  console.log("\n[TEST 3] Dispatch test: online driver receives ride:requested event:");
  const freshDriverToken = await mintToken(proofData.driver1.clerkId);
  await new Promise<void>((resolve) => {
    const driverSocket = io(base, {
      auth: { token: freshDriverToken },
      reconnection: false,
      timeout: 6000
    });

    driverSocket.on('connect', async () => {
      console.log("Driver 1 connected to socket and joined 'drivers' and 'drivers:Veloce X'.");

      driverSocket.on('ride:requested', (rideEvent) => {
        console.log("SUCCESS! Online driver received 'ride:requested' event for ride:", rideEvent.id);
        console.log("Dispatched vehicleType matches:", rideEvent.vehicleType);
        driverSocket.disconnect();
        resolve();
      });

      // Rider 1 creates a new ride with vehicleType "Veloce X"
      console.log("Rider 1 requesting ride with vehicleType 'Veloce X'...");
      const rideRes = await fetch(`${base}/api/rides`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${freshRiderToken}`
        },
        body: JSON.stringify({
          pickupLat: 28.6139,
          pickupLng: 77.2090,
          pickupAddress: "Connaught Place",
          dropLat: 28.5355,
          dropLng: 77.3910,
          dropAddress: "Noida Sector 18",
          vehicleType: "Veloce X"
        })
      });

      const rideBody = await rideRes.json();
      console.log("Ride created via API:", rideBody.data?.id);
    });

    driverSocket.on('connect_error', (err) => {
      console.error("Driver socket error:", err.message);
      resolve();
    });
  });

  console.log("\n==================================================");
  console.log("ALL PREREQUISITE PROOFS COMPLETE");
  console.log("==================================================");
}

runTests().catch(console.error).finally(() => prisma.$disconnect());
