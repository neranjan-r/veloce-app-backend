import fs from 'fs';
import path from 'path';

interface ProofData {
  rider1: { id: string; clerkId: string; token: string };
  rider2: { id: string; clerkId: string; token: string };
  driver1: { id: string; clerkId: string; token: string };
  driver2: { id: string; clerkId: string; token: string };
  ride1Id: string;
  ride2Id: string;
}

const proofData: ProofData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'proof_data.json'), 'utf8')
);

async function testEndpoint(name: string, command: string, url: string, options: RequestInit) {
  console.log(`\n========================================`);
  console.log(`TEST: ${name}`);
  console.log(`COMMAND:`);
  console.log(command);

  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`HTTP STATUS: ${res.status} ${res.statusText}`);
  console.log(`RESPONSE BODY:`);
  console.log(text);
  return { status: res.status, text };
}

async function run() {
  const base = 'http://localhost:4000';

  // 1. No token gives 401
  await testEndpoint(
    '1. No token gives 401',
    `curl -i ${base}/api/admin/stats`,
    `${base}/api/admin/stats`,
    { method: 'GET' }
  );

  // 2. Rider token plus an x-role: ADMIN header on /api/admin/stats gives 403
  await testEndpoint(
    '2. Rider token plus x-role: ADMIN header on /api/admin/stats gives 403',
    `curl -i ${base}/api/admin/stats \\\n  -H "Authorization: Bearer <RIDER1_TOKEN>" \\\n  -H "x-role: ADMIN"`,
    `${base}/api/admin/stats`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${proofData.rider1.token}`,
        'x-role': 'ADMIN'
      }
    }
  );

  // 3. Rider token on driver routes gives 403
  await testEndpoint(
    '3. Rider token on driver routes gives 403',
    `curl -i ${base}/api/driver/requests \\\n  -H "Authorization: Bearer <RIDER1_TOKEN>"`,
    `${base}/api/driver/requests`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${proofData.rider1.token}`
      }
    }
  );

  // 4. Driver cannot read another driver\'s ride gives 403
  // (Driver 2 attempting to read Ride 1 which belongs to Driver 1 and Rider 1)
  await testEndpoint(
    "4. Driver cannot read another driver's ride gives 403",
    `curl -i ${base}/api/rides/${proofData.ride1Id} \\\n  -H "Authorization: Bearer <DRIVER2_TOKEN>"`,
    `${base}/api/rides/${proofData.ride1Id}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${proofData.driver2.token}`
      }
    }
  );

  // 5a. Rider cannot read another rider\'s ride gives 403
  // (Rider 1 attempting to read Ride 2 which belongs to Rider 2)
  await testEndpoint(
    "5a. Rider cannot read another rider's ride gives 403",
    `curl -i ${base}/api/rides/${proofData.ride2Id} \\\n  -H "Authorization: Bearer <RIDER1_TOKEN>"`,
    `${base}/api/rides/${proofData.ride2Id}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${proofData.rider1.token}`
      }
    }
  );

  // 5b. Rider cannot read another rider\'s receipt gives 403
  // (Rider 1 attempting to read receipt of Ride 2 which belongs to Rider 2)
  await testEndpoint(
    "5b. Rider cannot read another rider's receipt gives 403",
    `curl -i ${base}/api/rides/${proofData.ride2Id}/receipt \\\n  -H "Authorization: Bearer <RIDER1_TOKEN>"`,
    `${base}/api/rides/${proofData.ride2Id}/receipt`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${proofData.rider1.token}`
      }
    }
  );
}

run().catch(console.error);
