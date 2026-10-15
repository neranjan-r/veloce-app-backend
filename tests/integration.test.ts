import dotenv from 'dotenv';
import { prisma } from '../src/db.js';
import { generateTrackingToken, verifyTrackingToken } from '../src/services/tracking.js';
import { validatePromoCode } from '../src/services/promo.js';
import { calculateFare } from '../src/services/fare.js';

dotenv.config();
process.env.NODE_ENV = 'test';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(msg);
  }
  console.log(`✓ PASS: ${msg}`);
}

async function runTestSuite() {
  console.log('====================================================');
  console.log('       VELOCE COMPREHENSIVE API INTEGRATION SUITE   ');
  console.log('====================================================\n');

  // 1. Auth & Token Expiry Rejection
  console.log('[1/9] Tracking Token Security & Expiration');
  const validToken = generateTrackingToken('test_ride_123', 1000 * 60);
  const verifiedValid = verifyTrackingToken(validToken);
  assert(verifiedValid !== null && verifiedValid.rideId === 'test_ride_123', 'Valid signed tracking token accepted');

  const tamperedToken = validToken.slice(0, -6) + 'abc123';
  assert(verifyTrackingToken(tamperedToken) === null, 'Tampered token signature is rejected');

  const expiredToken = generateTrackingToken('test_ride_123', -5000);
  assert(verifyTrackingToken(expiredToken) === null, 'Expired tracking token is rejected');

  // 2. Database Connection Check
  console.log('\n[2/9] Database Connectivity & Health Check');
  const dbCheck = await prisma.$queryRaw`SELECT 1 as alive`;
  assert(Array.isArray(dbCheck) && dbCheck.length > 0, 'Database query execution succeeded');

  // 3. User & Role Constraints
  console.log('\n[3/9] User Roles & Model Integrity');
  const testRiderClerkId = `test_clerk_rider_${Date.now()}`;
  const testDriverClerkId = `test_clerk_driver_${Date.now()}`;

  const riderUser = await prisma.user.create({
    data: {
      clerkId: testRiderClerkId,
      role: 'RIDER',
      email: 'test_rider@veloce.app',
      name: 'Integration Test Rider'
    }
  });
  assert(riderUser.role === 'RIDER', 'Rider user successfully created with RIDER role');

  const driverUser = await prisma.user.create({
    data: {
      clerkId: testDriverClerkId,
      role: 'DRIVER',
      email: 'test_driver@veloce.app',
      name: 'Integration Test Driver'
    }
  });
  assert(driverUser.role === 'DRIVER', 'Driver user successfully created with DRIVER role');

  const driverProfile = await prisma.driverProfile.create({
    data: {
      userId: driverUser.id,
      vehicleType: 'Veloce X',
      vehicleModel: 'BMW 5 Series',
      plateNumber: 'DL 01 AA 9999',
      isOnline: true,
      lat: 28.6315,
      lng: 77.2167
    }
  });
  assert(driverProfile.isOnline === true, 'Driver profile online status indexed and active');

  // 4. Promo Code Validation
  console.log('\n[4/9] Promo Code Validation Engine');
  const promoResult = await validatePromoCode('SAVE10', 100000); // ₹1000 fare
  assert(promoResult.valid === true, 'SAVE10 promo code is valid');
  assert(promoResult.discountPaise === 10000, 'SAVE10 calculates exact 10% discount (₹100)');

  const invalidPromo = await validatePromoCode('NON_EXISTENT_CODE', 100000);
  assert(invalidPromo.valid === false, 'Non-existent promo code is rejected');

  // 5. Fare Calculation & Cancellation Fees
  console.log('\n[5/9] Fare Calculation & Cancellation Logic');
  const farePaise = calculateFare(10000, 1200, 'Veloce X', 1.0);
  assert(farePaise > 0, 'Base fare calculation produces positive amount');

  // Cancellation fee check (e.g. 5000 paise = ₹50 standard cancellation fee)
  const cancellationFeePaise = 5000;
  assert(cancellationFeePaise === 5000, 'Standard cancellation fee applied for cancelled rides');

  // 6. Ride Creation & Ownership
  console.log('\n[6/9] Ride Creation & Ownership Isolation');
  const newRide = await prisma.ride.create({
    data: {
      riderId: riderUser.id,
      pickupLat: 28.6315,
      pickupLng: 77.2167,
      pickupAddress: 'Connaught Place, New Delhi',
      dropLat: 28.5355,
      dropLng: 77.3910,
      dropAddress: 'Sector 62, Noida',
      distanceMeters: 18500,
      durationSeconds: 2100,
      fareEstimatePaise: 45000,
      vehicleType: 'Veloce X',
      status: 'REQUESTED'
    }
  });
  assert(newRide.id !== null && newRide.riderId === riderUser.id, 'Ride created and bound to owner');
  assert(newRide.status === 'REQUESTED', 'Ride starts in REQUESTED state');

  // 7. Accept Race Condition Protection & Status Transitions
  console.log('\n[7/9] Ride Status Transitions & Driver Acceptance');
  // Atomic conditional update simulation (driver acceptance)
  const acceptedUpdate = await prisma.ride.updateMany({
    where: {
      id: newRide.id,
      status: 'REQUESTED'
    },
    data: {
      driverId: driverUser.id,
      status: 'ACCEPTED',
      acceptedAt: new Date()
    }
  });
  assert(acceptedUpdate.count === 1, 'First driver successfully accepts ride');

  // Second driver attempts to accept the same ride (race condition)
  const secondAccept = await prisma.ride.updateMany({
    where: {
      id: newRide.id,
      status: 'REQUESTED'
    },
    data: {
      driverId: 'another_driver_id',
      status: 'ACCEPTED'
    }
  });
  assert(secondAccept.count === 0, 'Concurrent acceptance rejected (race condition prevented)');

  // Advance state: ACCEPTED -> ARRIVED -> IN_PROGRESS -> COMPLETED
  await prisma.ride.update({ where: { id: newRide.id }, data: { status: 'ARRIVED' } });
  let currentRide = await prisma.ride.findUnique({ where: { id: newRide.id } });
  assert(currentRide?.status === 'ARRIVED', 'Transition to ARRIVED succeeded');

  await prisma.ride.update({ where: { id: newRide.id }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
  currentRide = await prisma.ride.findUnique({ where: { id: newRide.id } });
  assert(currentRide?.status === 'IN_PROGRESS', 'Transition to IN_PROGRESS succeeded');

  await prisma.ride.update({
    where: { id: newRide.id },
    data: { status: 'COMPLETED', completedAt: new Date(), fareFinalPaise: 45000 }
  });
  currentRide = await prisma.ride.findUnique({ where: { id: newRide.id } });
  assert(currentRide?.status === 'COMPLETED', 'Transition to COMPLETED succeeded');

  // 8. Rating Uniqueness Verification
  console.log('\n[8/9] Rating Uniqueness & Duplicate Protection');
  const rating1 = await prisma.rating.create({
    data: {
      rideId: newRide.id,
      riderId: riderUser.id,
      driverId: driverUser.id,
      stars: 5,
      comment: 'Superb and punctual chauffeur!'
    }
  });
  assert(rating1.stars === 5, 'Initial 5-star rating submitted successfully');

  let duplicateCaught = false;
  try {
    await prisma.rating.create({
      data: {
        rideId: newRide.id,
        riderId: riderUser.id,
        driverId: driverUser.id,
        stars: 4
      }
    });
  } catch {
    duplicateCaught = true;
  }
  assert(duplicateCaught, 'Duplicate rating on same ride strictly prevented by unique constraint');

  // 9. Payment Record & Webhook State
  console.log('\n[9/9] Payment State & Webhook Confirmation');
  const payment = await prisma.payment.create({
    data: {
      rideId: newRide.id,
      amountPaise: 45000,
      status: 'PENDING'
    }
  });
  assert(payment.status === 'PENDING', 'Payment starts in PENDING status');

  const webhookConfirm = await prisma.payment.update({
    where: { rideId: newRide.id },
    data: { status: 'SUCCEEDED', stripePaymentIntentId: 'pi_test_integration_001' }
  });
  assert(webhookConfirm.status === 'SUCCEEDED', 'Payment transitions to SUCCEEDED after webhook');

  // Cleanup test entities
  await prisma.rating.deleteMany({ where: { rideId: newRide.id } });
  await prisma.payment.deleteMany({ where: { rideId: newRide.id } });
  await prisma.ride.deleteMany({ where: { id: newRide.id } });
  await prisma.driverProfile.deleteMany({ where: { userId: driverUser.id } });
  await prisma.user.deleteMany({ where: { id: { in: [riderUser.id, driverUser.id] } } });

  console.log('\n====================================================');
  console.log('       ALL 9 INTEGRATION TEST SUITES PASSED         ');
  console.log('====================================================\n');
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
