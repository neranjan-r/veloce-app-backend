import http from 'http';
import express from 'express';
import cors from 'cors';
import { io as ClientIO } from '../web/node_modules/socket.io-client/build/esm/index.js';
import { prisma, getDbUser, requireAuth } from './src/index.js';
import { ridesRouter } from './src/routes/rides.js';
import { driverRouter } from './src/routes/driver.js';
import { initSockets } from './src/sockets.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/rides', requireAuth, ridesRouter);
app.use('/api/driver', requireAuth, driverRouter);

const server = http.createServer(app);
initSockets(server);

const TEST_PORT = 4099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`Test server running on port ${TEST_PORT}`);

  const results: { test: string; status: 'PASS' | 'FAIL'; details: string }[] = [];

  try {
    // Setup test users
    const driverUser = await getDbUser("test_driver_1", "DRIVER", "Rajesh Sharma");
    const driverUser2 = await getDbUser("test_driver_2", "DRIVER", "Vikram Singh");
    const riderUser = await getDbUser("test_rider_1", "RIDER", "Aarav Mehta");

    // Test a: Driver goes online, confirm isOnline=true and location in DB
    console.log("\n--- Testing (a): Driver goes online ---");
    const onlineRes = await fetch(`${BASE_URL}/api/driver/online`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" },
      body: JSON.stringify({ lat: 28.6315, lng: 77.2167, vehicleType: "Veloce X" })
    });
    const onlineData = await onlineRes.json() as any;
    const profileInDb = await prisma.driverProfile.findUnique({ where: { userId: driverUser.id } });

    if (profileInDb && profileInDb.isOnline && profileInDb.lat === 28.6315 && profileInDb.lng === 77.2167) {
      results.push({ test: "a. Driver goes online & coordinates stored in DB", status: "PASS", details: `isOnline=${profileInDb.isOnline}, lat=${profileInDb.lat}, lng=${profileInDb.lng}` });
    } else {
      results.push({ test: "a. Driver goes online & coordinates stored in DB", status: "FAIL", details: `DB Profile: ${JSON.stringify(profileInDb)}` });
    }

    // Connect Driver Socket
    const driverSocket = ClientIO(BASE_URL, {
      query: { userId: driverUser.id, role: "DRIVER", vehicleType: "Veloce X" }
    });
    await new Promise<void>((resolve) => driverSocket.on("connect", () => resolve()));

    // Test b & c: Rider books ride and driver receives request within 2 seconds without refreshing
    console.log("\n--- Testing (b & c): Rider books ride and driver receives socket event ---");
    let receivedRideOnDriver: any = null;
    const receivePromise = new Promise<any>((resolve) => {
      driverSocket.on("ride:requested", (data) => {
        receivedRideOnDriver = data;
        resolve(data);
      });
    });

    const bookStart = Date.now();
    const bookRes = await fetch(`${BASE_URL}/api/rides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "Connaught Place, New Delhi",
        dropLat: 28.4952,
        dropLng: 77.0891,
        dropAddress: "Cyber Hub, Gurugram",
        vehicleType: "Veloce X"
      })
    });
    const bookData = await bookRes.json() as any;
    const ride1 = bookData.data;

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout 2s")), 2000));
    try {
      await Promise.race([receivePromise, timeoutPromise]);
      const elapsed = Date.now() - bookStart;
      results.push({ test: "b & c. Booking Connaught Place to Cyber Hub & received by driver <2s", status: "PASS", details: `Received within ${elapsed}ms, rideId=${ride1.id}` });
    } catch (e: any) {
      results.push({ test: "b & c. Booking Connaught Place to Cyber Hub & received by driver <2s", status: "FAIL", details: e.message });
    }

    // Connect Rider Socket & join ride room
    const riderSocket = ClientIO(BASE_URL, {
      query: { userId: riderUser.id, role: "RIDER" }
    });
    await new Promise<void>((resolve) => riderSocket.on("connect", () => resolve()));
    riderSocket.emit("ride:join", ride1.id);

    // Test d: Driver accepts, Rider receives driver details without refreshing
    console.log("\n--- Testing (d): Driver accepts, Rider receives driver details ---");
    let riderReceivedAccept: any = null;
    const riderAcceptPromise = new Promise<any>((resolve) => {
      riderSocket.on("ride:accepted", (data) => {
        riderReceivedAccept = data;
        resolve(data);
      });
    });

    const acceptRes = await fetch(`${BASE_URL}/api/rides/${ride1.id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    const acceptData = await acceptRes.json() as any;

    await Promise.race([riderAcceptPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for accept event")), 3000))]);

    if (riderReceivedAccept?.driver?.name === "Rajesh Sharma" && riderReceivedAccept?.ride?.status === "ACCEPTED") {
      results.push({ test: "d. Driver accepts & rider receives driver details live", status: "PASS", details: `Driver: ${riderReceivedAccept.driver.name}, Status: ${riderReceivedAccept.ride.status}` });
    } else {
      results.push({ test: "d. Driver accepts & rider receives driver details live", status: "FAIL", details: JSON.stringify(riderReceivedAccept) });
    }

    // Test e: Driver arrives, starts, moves location, completes
    console.log("\n--- Testing (e): Driver lifecycle (arrived, start, location, complete) ---");
    let statusUpdates: string[] = [];
    let receivedDriverLocation: any = null;

    riderSocket.on("ride:status", (data: any) => {
      statusUpdates.push(data.status);
    });
    riderSocket.on("driver:location", (data: any) => {
      receivedDriverLocation = data;
    });

    // Driver marks Arrived
    await fetch(`${BASE_URL}/api/rides/${ride1.id}/arrived`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    await new Promise(r => setTimeout(r, 200));

    // Driver marks Start ride
    await fetch(`${BASE_URL}/api/rides/${ride1.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    await new Promise(r => setTimeout(r, 200));

    // Driver updates location during trip
    await fetch(`${BASE_URL}/api/driver/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" },
      body: JSON.stringify({ lat: 28.5500, lng: 77.1500 })
    });
    await new Promise(r => setTimeout(r, 300));

    // Driver marks Complete ride
    await fetch(`${BASE_URL}/api/rides/${ride1.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
    });
    await new Promise(r => setTimeout(r, 300));

    const lifecyclePass = statusUpdates.includes("ARRIVED") &&
                          statusUpdates.includes("IN_PROGRESS") &&
                          statusUpdates.includes("COMPLETED") &&
                          receivedDriverLocation !== null;

    if (lifecyclePass) {
      results.push({
        test: "e. Driver presses Arrived, Start, moves location, and Completes live",
        status: "PASS",
        details: `Status sequence: [${statusUpdates.join(" -> ")}], Location: (${receivedDriverLocation.lat}, ${receivedDriverLocation.lng})`
      });
    } else {
      results.push({
        test: "e. Driver presses Arrived, Start, moves location, and Completes live",
        status: "FAIL",
        details: `Updates: [${statusUpdates.join(", ")}], Location: ${JSON.stringify(receivedDriverLocation)}`
      });
    }

    // Test f: Rider books second ride and cancels it while REQUESTED. Driver receives cancel event.
    console.log("\n--- Testing (f): Rider cancels REQUESTED ride ---");
    let driverReceivedCancel = false;
    driverSocket.on("ride:cancelled", (data) => {
      if (data.rideId) driverReceivedCancel = true;
    });

    const book2Res = await fetch(`${BASE_URL}/api/rides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "Connaught Place, New Delhi",
        dropLat: 28.5355,
        dropLng: 77.3910,
        dropAddress: "Noida Sector 18",
        vehicleType: "Veloce X"
      })
    });
    const book2Data = await book2Res.json() as any;
    const ride2 = book2Data.data;
    await new Promise(r => setTimeout(r, 200));

    const cancelRes = await fetch(`${BASE_URL}/api/rides/${ride2.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" }
    });
    await new Promise(r => setTimeout(r, 400));

    if (driverReceivedCancel) {
      results.push({ test: "f. Rider cancels REQUESTED ride & disappears on driver side", status: "PASS", details: `Cancelled rideId=${ride2.id}` });
    } else {
      results.push({ test: "f. Rider cancels REQUESTED ride & disappears on driver side", status: "FAIL", details: "Driver socket did not receive ride:cancelled" });
    }

    // Test g: Two drivers accept the same ride at the same moment
    console.log("\n--- Testing (g): Simultaneous accept race condition ---");
    const book3Res = await fetch(`${BASE_URL}/api/rides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": riderUser.id, "x-role": "RIDER" },
      body: JSON.stringify({
        pickupLat: 28.6315,
        pickupLng: 77.2167,
        pickupAddress: "Connaught Place",
        dropLat: 28.6129,
        dropLng: 77.2295,
        dropAddress: "India Gate",
        vehicleType: "Veloce X"
      })
    });
    const book3Data = await book3Res.json() as any;
    const ride3 = book3Data.data;

    // Both drivers accept concurrently
    const [res1, res2] = await Promise.all([
      fetch(`${BASE_URL}/api/rides/${ride3.id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": driverUser.id, "x-role": "DRIVER" }
      }),
      fetch(`${BASE_URL}/api/rides/${ride3.id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": driverUser2.id, "x-role": "DRIVER" }
      })
    ]);

    const data1 = await res1.json() as any;
    const data2 = await res2.json() as any;

    const oneSucceeded = (res1.status === 200 && data1.data?.success) || (res2.status === 200 && data2.data?.success);
    const oneFailed = (res1.status === 409 && data1.error?.code === 'RIDE_ALREADY_ACCEPTED') ||
                      (res2.status === 409 && data2.error?.code === 'RIDE_ALREADY_ACCEPTED');

    if (oneSucceeded && oneFailed) {
      results.push({
        test: "g. Two drivers accept simultaneously: exactly one wins, other gets 409 error",
        status: "PASS",
        details: `Winner: ${res1.status === 200 ? 'Driver 1' : 'Driver 2'} (200), Loser: ${res1.status === 409 ? 'Driver 1' : 'Driver 2'} (409 RIDE_ALREADY_ACCEPTED)`
      });
    } else {
      results.push({
        test: "g. Two drivers accept simultaneously: exactly one wins, other gets 409 error",
        status: "FAIL",
        details: `Driver1 status: ${res1.status} (${JSON.stringify(data1)}), Driver2 status: ${res2.status} (${JSON.stringify(data2)})`
      });
    }

    driverSocket.disconnect();
    riderSocket.disconnect();
  } catch (err: any) {
    console.error("Test execution error:", err);
  } finally {
    server.close();
    console.log("\n=================== PHASE 1 TEST RESULTS ===================");
    console.table(results);
    process.exit(results.every(r => r.status === 'PASS') ? 0 : 1);
  }
}

runTests();
