import http from "http";
import WebSocket from "ws";

const BASE_URL = "http://127.0.0.1:3000";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function makeRequest(
  method: string,
  pathStr: string,
  body?: any,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, BASE_URL);
    const headers: Record<string, string> = { ...extraHeaders };

    let payload: string | undefined;
    if (body !== undefined) {
      if (typeof body === "string") {
        payload = body;
      } else if (headers["Content-Type"] === "application/x-www-form-urlencoded") {
        payload = new URLSearchParams(body).toString();
      } else {
        payload = JSON.stringify(body);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
      headers["Content-Length"] = Buffer.byteLength(payload).toString();
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const req = http.request(
      url,
      {
        method,
        headers
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          let parsed: any = rawData;
          try {
            parsed = JSON.parse(rawData);
          } catch {}
          resolve({ status: res.statusCode || 0, data: parsed, headers: res.headers });
        });
      }
    );

    req.on("error", (err) => reject(err));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runRegressionTestSuite() {
  console.log("================================================================================");
  console.log("RUNNING LOCATION CHRONOLOGICAL FRESHNESS & ORDERING REGRESSION TEST SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();
  const usernameA = `usera_${timestamp}`;
  const usernameB = `userb_${timestamp}`;
  const password = "Password123!";

  // 1. REGISTER USERS
  console.log("\n[TEST 1] Registering User A and User B...");
  const regA = await makeRequest("POST", "/api/auth/register", {
    username: usernameA,
    password,
    display_name: "User A"
  });
  assert(regA.status === 200, "User A registration failed");
  const tokenA = regA.data.access_token;

  const regB = await makeRequest("POST", "/api/auth/register", {
    username: usernameB,
    password,
    display_name: "User B"
  });
  assert(regB.status === 200, "User B registration failed");
  const tokenB = regB.data.access_token;
  console.log("✓ User A and User B registered.");

  // 2. FETCH TRACCAR TOKENS
  console.log("\n[TEST 2] Provisioning Traccar devices for User A and User B...");
  const configA = await makeRequest("GET", "/api/traccar/config", undefined, tokenA);
  const traccarTokenA = configA.data.token;

  const configB = await makeRequest("GET", "/api/traccar/config", undefined, tokenB);
  const traccarTokenB = configB.data.token;
  console.log(`✓ Device tokens fetched: User A (${traccarTokenA.slice(0, 8)}...), User B (${traccarTokenB.slice(0, 8)}...)`);

  // CREATE A FAMILY CIRCLE
  console.log("\n[TEST 3] Setting up circle membership...");
  const circleRes = await makeRequest("POST", "/api/circles", { name: "Audit Circle" }, tokenA);
  assert(circleRes.status === 200, "Circle creation failed");
  const circleId = circleRes.data.id;
  const inviteCode = circleRes.data.invite_code;

  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, tokenB);
  assert(joinRes.status === 200, "User B join circle failed");
  console.log(`✓ Family circle setup complete. Circle ID: ${circleId}`);

  // Define points
  const time10 = 1790800000; // 10:00 (seconds epoch)
  const time11 = 1790803600; // 11:00 (seconds epoch)

  // ---------------------------------------------------------------------------
  // TEST 4: NEWER → OLDER TELEMETRY FLOW
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Processing NEWER then OLDER out-of-order Traccar telemetry (User A)...");

  // Step A: Send Point 11:00 (Newer)
  console.log(" -> Submitting newer telemetry at 11:00...");
  const pointNewer = await makeRequest("GET", `/api/traccar/${traccarTokenA}?id=${usernameA}&lat=-38.111&lon=145.222&timestamp=${time11}`);
  assert(pointNewer.status === 200, "Failed to submit Point B");

  // Step B: Send Point 10:00 (Older, out-of-order)
  console.log(" -> Submitting older out-of-order telemetry at 10:00...");
  const pointOlder = await makeRequest("GET", `/api/traccar/${traccarTokenA}?id=${usernameA}&lat=-38.999&lon=145.999&timestamp=${time10}`);
  assert(pointOlder.status === 200, "Failed to submit Point A");

  // Step C: Verify EntityState retains the newer 11:00 coordinates
  console.log(" -> Verifying current map/entity state retains Point 11:00...");
  const statesRes = await makeRequest("GET", "/api/states", undefined, tokenA);
  const esA = statesRes.data.find((e: any) => e.entity_id === `device_tracker.${usernameA.toLowerCase()}`);
  assert(Boolean(esA), "EntityState not found");
  assert(esA.latitude === -38.111 && esA.longitude === 145.222, `Expected newer coordinates (-38.111, 145.222), but got stale coords (${esA.latitude}, ${esA.longitude})`);
  console.log("✓ SUCCESS: Stale out-of-order location was rejected for EntityState mutation.");

  // ---------------------------------------------------------------------------
  // TEST 5: HISTORY RETENTION
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Verifying LocationHistory preserves the stale telemetry point...");
  const historyRes = await makeRequest("GET", "/api/history/period?hours=1", undefined, tokenA);
  // Verify both points exist in history records
  const histPoints = historyRes.data || [];
  const contains10 = histPoints.some((p: any) => p.latitude === -38.999);
  const contains11 = histPoints.some((p: any) => p.latitude === -38.111);
  assert(contains10 && contains11, "LocationHistory did not retain all historical telemetry points!");
  console.log("✓ SUCCESS: Stale telemetry point safely saved to history logs.");

  // ---------------------------------------------------------------------------
  // TEST 6: EQUAL TIMESTAMP TIE-BREAKER
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Processing EQUAL TIMESTAMP tie-breaker...");
  const pointAlt = await makeRequest("GET", `/api/traccar/${traccarTokenA}?id=${usernameA}&lat=-38.555&lon=145.555&timestamp=${time11}`);
  assert(pointAlt.status === 200, "Failed to submit alternative Point B");

  const statesRes2 = await makeRequest("GET", "/api/states", undefined, tokenA);
  const esA2 = statesRes2.data.find((e: any) => e.entity_id === `device_tracker.${usernameA.toLowerCase()}`);
  assert(esA2.latitude === -38.555, `Equal timestamp did not win/tie-break correctly: got ${esA2.latitude}`);
  console.log("✓ SUCCESS: Equal timestamp tie-breaker processed correctly.");

  // ---------------------------------------------------------------------------
  // TEST 7: MULTI-USER ISOLATION
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 7] Verifying multi-user isolation protections...");
  const pointUserB = await makeRequest("GET", `/api/traccar/${traccarTokenB}?id=${usernameB}&lat=-40.000&lon=140.000&timestamp=${time11}`);
  assert(pointUserB.status === 200, "Failed to submit point for User B");

  // Verify User A cannot access or mutate User B's state
  const statesResB = await makeRequest("GET", "/api/states", undefined, tokenA);
  const containsB = statesResB.data.some((e: any) => e.entity_id === `device_tracker.${usernameb_id(usernameB)}`);
  assert(!containsB, "User A leaked User B's private entity states!");
  console.log("✓ SUCCESS: Multi-user state access and telemetry ingestion remains strictly isolated.");

  // ---------------------------------------------------------------------------
  // TEST 8: CIRCLE MEMBERS API SYNC
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 8] Verifying Circles members API returns the newest accepted state...");
  const membersRes = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, tokenA);
  assert(membersRes.status === 200, "Failed to fetch members list");
  const memberA = membersRes.data.find((m: any) => m.username === usernameA);
  assert(memberA.devices[0].latitude === -38.555, `Stale coordinates returned in circles payload: got ${memberA.devices[0].latitude}`);
  console.log("✓ SUCCESS: Circle members API serves only the authoritative newest state.");

  console.log("\n================================================================================");
  console.log("✓ ALL REGRESSION TESTS PASSED! ARCHITECTURAL CHRONOLOGY INVARIANT SECURED.");
  console.log("================================================================================");
}

function usernameb_id(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

runRegressionTestSuite().catch((err) => {
  console.error("❌ REGRESSION TEST SUITE FAILED:", err);
  process.exit(1);
});
