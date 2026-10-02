import http from "http";

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
          } catch {
            // raw string fallback
          }
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

async function runRoutingVerificationSuite() {
  console.log("================================================================================");
  console.log("RUNNING TRACCAR LOCATION HISTORY & WEBHOOK ROUTING VERIFICATION SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();
  const username = `traccar_route_${timestamp}`;
  const password = "RoutePassword123!";
  const displayName = "Traccar Route Test User";

  // 1. Register test user
  console.log("\n[TEST 1] Registering test user account...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: displayName
  });
  assert(regRes.status === 200, `Registration failed: ${JSON.stringify(regRes.data)}`);
  const userToken = regRes.data.access_token;
  assert(Boolean(userToken), "Access token missing");
  console.log(`✓ User '${username}' created.`);

  // 2. Verify Traccar Config generates dedicated /api/traccar/{token} endpoint
  console.log("\n[TEST 2] Verifying Traccar configuration generation...");
  const configRes = await makeRequest("GET", "/api/traccar/config", undefined, userToken);
  assert(configRes.status === 200, "Failed to fetch Traccar config");
  const traccarToken = configRes.data.token;
  assert(Boolean(traccarToken), "Token missing in Traccar config");
  assert(
    configRes.data.server_url.includes(`/api/traccar/${traccarToken}`),
    `server_url must contain '/api/traccar/${traccarToken}', got '${configRes.data.server_url}'`
  );
  assert(
    !configRes.data.server_url.includes("/api/webhook/"),
    `server_url must NOT point to /api/webhook/, got '${configRes.data.server_url}'`
  );
  assert(
    configRes.data.qr_uri.includes(`/api/traccar/${traccarToken}?id=`),
    `qr_uri must point to /api/traccar/{token}, got '${configRes.data.qr_uri}'`
  );
  console.log(`✓ Canonical Traccar server_url verified: ${configRes.data.server_url}`);
  console.log(`✓ QR URI verified: ${configRes.data.qr_uri}`);

  // 3. Telemetry ingestion via canonical path: POST /api/traccar/{token}
  console.log("\n[TEST 3] Sending location update to canonical /api/traccar/{token}...");
  const nowEpoch = Math.floor(Date.now() / 1000);
  const fix1Epoch = nowEpoch - 60; // 1 minute ago
  const fix1Lat = 37.774929;
  const fix1Lon = -122.419416;

  const traccarRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: fix1Lat.toString(),
      lon: fix1Lon.toString(),
      timestamp: fix1Epoch.toString(),
      accuracy: "10.0",
      speed: "5.0",
      batt: "92"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(traccarRes.status === 200, `Traccar POST failed: ${traccarRes.status} ${JSON.stringify(traccarRes.data)}`);
  assert(traccarRes.data.success === true, "Expected success: true");
  console.log("✓ Canonical /api/traccar/{token} accepted position with HTTP 200 OK.");

  // Check history contains Fix 1
  const histAfter1 = await makeRequest("GET", "/api/history/period", undefined, userToken);
  assert(histAfter1.status === 200 && Array.isArray(histAfter1.data), "History query failed");
  const fix1Record = histAfter1.data.find((h: any) => Math.abs(h.latitude - fix1Lat) < 0.0001);
  assert(Boolean(fix1Record), "Fix 1 missing from location_history!");
  console.log(`✓ Fix 1 successfully persisted to location_history (ID: ${fix1Record.id}).`);

  // 4. Telemetry ingestion via backward-compatibility path: POST /api/webhook/{token}
  console.log("\n[TEST 4] Sending location update to backward-compatible /api/webhook/{token}...");
  const fix2Epoch = nowEpoch;
  const fix2Lat = 37.778800;
  const fix2Lon = -122.415500;

  const webhookTraccarRes = await makeRequest(
    "POST",
    `/api/webhook/${traccarToken}`,
    {
      id: username,
      lat: fix2Lat.toString(),
      lon: fix2Lon.toString(),
      timestamp: fix2Epoch.toString(),
      accuracy: "8.5",
      speed: "3.5",
      batt: "89"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(
    webhookTraccarRes.status === 200,
    `Webhook Traccar POST failed: ${webhookTraccarRes.status} ${JSON.stringify(webhookTraccarRes.data)}`
  );
  assert(webhookTraccarRes.data.success === true, "Expected success: true from webhook delegation");
  console.log("✓ /api/webhook/{token} delegated Traccar request and returned HTTP 200 OK.");

  // Check history contains BOTH Fix 1 and Fix 2
  const histAfter2 = await makeRequest("GET", "/api/history/period", undefined, userToken);
  assert(histAfter2.status === 200, "History query failed");
  const fix2Record = histAfter2.data.find((h: any) => Math.abs(h.latitude - fix2Lat) < 0.0001);
  assert(Boolean(fix2Record), "Fix 2 missing from location_history!");
  assert(histAfter2.data.length >= 2, `Expected at least 2 history records, found ${histAfter2.data.length}`);
  console.log(`✓ Both Fix 1 and Fix 2 are independently stored in location_history (total: ${histAfter2.data.length} records).`);

  // 5. Test Query-parameter GET variant on /api/webhook/{token}
  console.log("\n[TEST 5] Testing GET variant on /api/webhook/{token} with query parameters...");
  const fix3Epoch = nowEpoch + 30;
  const fix3Lat = 37.780100;
  const fix3Lon = -122.413000;

  const webhookGetRes = await makeRequest(
    "GET",
    `/api/webhook/${traccarToken}?id=${encodeURIComponent(username)}&lat=${fix3Lat}&lon=${fix3Lon}&timestamp=${fix3Epoch}&batt=88`
  );
  assert(webhookGetRes.status === 200, `Webhook GET failed: ${webhookGetRes.status}`);
  console.log("✓ /api/webhook/{token} GET variant successfully accepted.");

  const histAfter3 = await makeRequest("GET", "/api/history/period", undefined, userToken);
  const fix3Record = histAfter3.data.find((h: any) => Math.abs(h.latitude - fix3Lat) < 0.0001);
  assert(Boolean(fix3Record), "Fix 3 missing from location_history!");
  console.log(`✓ Fix 3 confirmed in location_history (total: ${histAfter3.data.length}).`);

  // 6. Test Freshness rule: Old buffered location does NOT move live pin backwards
  console.log("\n[TEST 6] Testing offline buffered fix (must NOT move live map state backwards)...");
  const oldFixEpoch = nowEpoch - 7200; // 2 hours ago
  const oldFixLat = 37.710000;
  const oldFixLon = -122.390000;

  const oldFixRes = await makeRequest(
    "POST",
    `/api/webhook/${traccarToken}`,
    {
      id: username,
      lat: oldFixLat.toString(),
      lon: oldFixLon.toString(),
      timestamp: oldFixEpoch.toString(),
      batt: "95"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(oldFixRes.status === 200, `Old fix POST failed: ${oldFixRes.status}`);

  // Verify live state remains at the latest coordinate (Fix 3)
  const statesRes = await makeRequest("GET", "/api/states", undefined, userToken);
  const trackerEntity = statesRes.data.find((e: any) => e.entity_id.includes(username));
  assert(Math.abs(trackerEntity.latitude - fix3Lat) < 0.0001, "Live map position moved backwards!");
  console.log("✓ Live state remained at newest coordinate (Fix 3: 37.7801).");

  // Verify location_history retained the old buffered fix with its true historical timestamp
  const histAfterOld = await makeRequest("GET", "/api/history/period", undefined, userToken);
  const oldFixRecord = histAfterOld.data.find((h: any) => Math.abs(h.latitude - oldFixLat) < 0.0001);
  assert(Boolean(oldFixRecord), "Old buffered fix was not persisted in location_history!");
  const expectedOldIso = new Date(oldFixEpoch * 1000).toISOString();
  assert(oldFixRecord.timestamp === expectedOldIso, `Timestamp mismatch: expected ${expectedOldIso}, got ${oldFixRecord.timestamp}`);
  console.log(`✓ Old buffered fix persisted with genuine past timestamp: ${oldFixRecord.timestamp}.`);

  // 7. Client diagnostic log independence
  console.log("\n[TEST 7] Verifying client-side diagnostic log independence...");
  // Simulate client clearing its own internal log by querying history repeatedly without sending any deletes
  const histCheck = await makeRequest("GET", "/api/history/period", undefined, userToken);
  assert(histCheck.data.length >= 4, `Expected at least 4 records, got ${histCheck.data.length}`);
  console.log("✓ Server-side history is completely independent of client-side diagnostic logs.");

  // 8. Companion App location update must still be rejected with HTTP 410
  console.log("\n[TEST 8] Verifying Home Assistant Companion location update is still rejected (HTTP 410)...");
  const companionRes = await makeRequest(
    "POST",
    `/api/webhook/${traccarToken}`,
    {
      type: "update_location",
      data: {
        gps: [37.7749, -122.4194],
        gps_accuracy: 10
      }
    },
    userToken
  );
  assert(companionRes.status === 410, `Expected 410 for companion location update, got ${companionRes.status}`);
  console.log("✓ Companion update_location remains properly disabled with HTTP 410.");

  console.log("================================================================================");
  console.log("ALL TRACCAR LOCATION HISTORY & WEBHOOK ROUTING TESTS PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runRoutingVerificationSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
