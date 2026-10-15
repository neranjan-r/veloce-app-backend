import { createClerkClient } from '@clerk/express';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY || '' });

const RIDER_1_CLERK_ID = process.env.PROOF_RIDER_1_ID || 'user_3KZ3YkSdinJeWIvmG3j9GJXySod';
const RIDER_2_CLERK_ID = process.env.PROOF_RIDER_2_ID || 'user_3KZ3Ymv1831bT6tAGFuHoVc9Zrd';
const DRIVER_1_CLERK_ID = process.env.PROOF_DRIVER_1_ID || 'user_3KZ3YtaHX2xCUSupc6pg9mwNoFw';
const DRIVER_2_CLERK_ID = process.env.PROOF_DRIVER_2_ID || 'user_3KZ3YyVRrrlmRQNSkZAoPgMJ2IK';

async function main() {
  console.log("Setting up DB users...");

  // 1. Upsert users in DB
  const rider1 = await prisma.user.upsert({
    where: { clerkId: RIDER_1_CLERK_ID },
    update: { role: 'RIDER', name: 'Rider One', email: 'rider1_proof@veloce.app' },
    create: { clerkId: RIDER_1_CLERK_ID, role: 'RIDER', name: 'Rider One', email: 'rider1_proof@veloce.app' },
  });

  const rider2 = await prisma.user.upsert({
    where: { clerkId: RIDER_2_CLERK_ID },
    update: { role: 'RIDER', name: 'Rider Two', email: 'rider2_proof@veloce.app' },
    create: { clerkId: RIDER_2_CLERK_ID, role: 'RIDER', name: 'Rider Two', email: 'rider2_proof@veloce.app' },
  });

  const driver1 = await prisma.user.upsert({
    where: { clerkId: DRIVER_1_CLERK_ID },
    update: { role: 'DRIVER', name: 'Driver One', email: 'driver1_proof@veloce.app' },
    create: { clerkId: DRIVER_1_CLERK_ID, role: 'DRIVER', name: 'Driver One', email: 'driver1_proof@veloce.app' },
  });

  const driver2 = await prisma.user.upsert({
    where: { clerkId: DRIVER_2_CLERK_ID },
    update: { role: 'DRIVER', name: 'Driver Two', email: 'driver2_proof@veloce.app' },
    create: { clerkId: DRIVER_2_CLERK_ID, role: 'DRIVER', name: 'Driver Two', email: 'driver2_proof@veloce.app' },
  });

  // Ensure driver profiles exist
  await prisma.driverProfile.upsert({
    where: { userId: driver1.id },
    update: { isOnline: true },
    create: { userId: driver1.id, isOnline: true, vehicleType: 'Veloce X', plateNumber: 'DL 01 AB 1111' },
  });

  await prisma.driverProfile.upsert({
    where: { userId: driver2.id },
    update: { isOnline: true },
    create: { userId: driver2.id, isOnline: true, vehicleType: 'Veloce X', plateNumber: 'DL 02 CD 2222' },
  });

  // 2. Create sample rides
  // Ride 1 belongs to rider1 and driver1
  const ride1 = await prisma.ride.create({
    data: {
      riderId: rider1.id,
      driverId: driver1.id,
      vehicleType: "Veloce X",
      pickupLat: 28.6139,
      pickupLng: 77.2090,
      pickupAddress: "Connaught Place, New Delhi",
      dropLat: 28.5355,
      dropLng: 77.3910,
      dropAddress: "Noida Sector 18",
      distanceMeters: 15000,
      durationSeconds: 1800,
      fareEstimatePaise: 45000,
      fareFinalPaise: 45000,
      status: "COMPLETED",
      payment: {
        create: {
          amountPaise: 45000,
          status: "PAID",
          stripePaymentIntentId: "pi_test_ride1",
          driverPayoutPaise: 36000,
          platformFeePaise: 9000
        }
      }
    }
  });

  // Ride 2 belongs to rider2 and driver2
  const ride2 = await prisma.ride.create({
    data: {
      riderId: rider2.id,
      driverId: driver2.id,
      vehicleType: "Veloce X",
      pickupLat: 28.5000,
      pickupLng: 77.1000,
      pickupAddress: "Cyber Hub, Gurugram",
      dropLat: 28.6139,
      dropLng: 77.2090,
      dropAddress: "Connaught Place, New Delhi",
      distanceMeters: 25000,
      durationSeconds: 2700,
      fareEstimatePaise: 65000,
      fareFinalPaise: 65000,
      status: "COMPLETED",
      payment: {
        create: {
          amountPaise: 65000,
          status: "PAID",
          stripePaymentIntentId: "pi_test_ride2",
          driverPayoutPaise: 52000,
          platformFeePaise: 13000
        }
      }
    }
  });

  // 3. Mint Clerk session tokens
  console.log("Minting Clerk tokens...");
  async function getTokenForUser(userId: string) {
    const session = await clerk.sessions.createSession({ userId });
    const token = await clerk.sessions.getToken(session.id);
    return token.jwt;
  }

  const rider1Token = await getTokenForUser(RIDER_1_CLERK_ID);
  const rider2Token = await getTokenForUser(RIDER_2_CLERK_ID);
  const driver1Token = await getTokenForUser(DRIVER_1_CLERK_ID);
  const driver2Token = await getTokenForUser(DRIVER_2_CLERK_ID);

  const proofData = {
    rider1: { id: rider1.id, clerkId: RIDER_1_CLERK_ID, token: rider1Token },
    rider2: { id: rider2.id, clerkId: RIDER_2_CLERK_ID, token: rider2Token },
    driver1: { id: driver1.id, clerkId: DRIVER_1_CLERK_ID, token: driver1Token },
    driver2: { id: driver2.id, clerkId: DRIVER_2_CLERK_ID, token: driver2Token },
    ride1Id: ride1.id,
    ride2Id: ride2.id,
  };

  fs.writeFileSync(path.join(process.cwd(), 'proof_data.json'), JSON.stringify(proofData, null, 2));
  console.log("Saved proof data to proof_data.json");
  console.log("Ride 1 (Rider1 + Driver1):", ride1.id);
  console.log("Ride 2 (Rider2 + Driver2):", ride2.id);
}

main().catch(console.error).finally(() => prisma.$disconnect());
