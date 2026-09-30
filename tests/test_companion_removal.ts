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
          } catch {
            // Raw text fallback
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

async function runCompanionRemovalVerification() {
  console.log("================================================================================");
  console.log("RUNNING COMPANION REMOVAL & TRACCAR SOLE-SOURCE VERIFICATION SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();
  const username = `traccar_only_${timestamp}`;
  const password = "TraccarPass123!";
  const displayName = "Traccar Only User";

  // 1. Register User
  console.log("\n[TEST 1] Registering Yimly user...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: displayName
  });
  assert(regRes.status === 200, `Registration failed: ${JSON.stringify(regRes.data)}`);
  const userToken = regRes.data.access_token;
  console.log(`✓ User '${username}' registered successfully.`);

  // 2. Query Traccar Config
  console.log("\n[TEST 2] Verifying Traccar Client configuration...");
  const configRes = await makeRequest("GET", "/api/traccar/config", undefined, userToken);
  assert(configRes.status === 200, `Config failed: ${JSON.stringify(configRes.data)}`);
  const traccarToken = configRes.data.token;
  assert(Boolean(traccarToken), "Missing traccar token");
  console.log(`✓ Traccar device configured with token: ${traccarToken}`);

  // 3. Verify Companion App Mobile Registration is Disabled (HTTP 410)
  console.log("\n[TEST 3] Verifying POST /api/mobile_app/registrations is disabled (HTTP 410)...");
  const compRegRes = await makeRequest(
    "POST",
    "/api/mobile_app/registrations",
    { device_id: "test_companion_dev", device_name: "Test Companion Phone" },
    userToken
  );
  assert(compRegRes.status === 410, `Expected 410 for companion registration, got ${compRegRes.status}`);
  console.log("✓ Companion mobile_app registration is disabled (HTTP 410).");

  // 4. Verify Companion App Webhook Location Ingestion is Disabled (HTTP 410)
  console.log("\n[TEST 4] Verifying /api/webhook/:webhook_id rejects location updates (HTTP 410)...");
  const webhookLocRes = await makeRequest(
    "POST",
    `/api/webhook/${traccarToken}`,
    {
      type: "update_location",
      data: {
        gps: [37.7749, -122.4194],
        gps_accuracy: 10,
        battery: 90
      }
    },
    userToken
  );
  assert(webhookLocRes.status === 410, `Expected 410 for companion location update, got ${webhookLocRes.status}`);
  console.log("✓ Companion webhook location ingestion is rejected with HTTP 410.");

  // Also verify that entity_states was NOT updated by companion webhook
  const statesRes1 = await makeRequest("GET", "/api/states", undefined, userToken);
  const trackerEntity1 = statesRes1.data.find((e: any) => e.entity_id.includes(username));
  assert(trackerEntity1 && trackerEntity1.latitude === null, "Companion webhook erroneously updated entity latitude!");
  console.log("✓ Verified companion webhook did not modify entity states.");

  // 5. Send Traccar Location and Verify 200 OK & Proper Pipeline Updates
  console.log("\n[TEST 5] Sending valid Traccar location update...");
  const fixSeconds = Math.floor(Date.now() / 1000);
  const traccarRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: "37.783300",
      lon: "-122.416700",
      timestamp: fixSeconds.toString(),
      accuracy: "8.0",
      altitude: "20.0",
      speed: "12.0", // 12 knots
      bearing: "90.0",
      batt: "84",
      charge: "true"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(traccarRes.status === 200, `Traccar POST failed: ${JSON.stringify(traccarRes.data)}`);
  console.log("✓ Traccar POST returned HTTP 200 OK.");

  // 6. Verify EntityState Stored Latitude, Longitude, Battery, Speed, Charging
  console.log("\n[TEST 6] Verifying EntityState attributes updated from Traccar...");
  const statesRes2 = await makeRequest("GET", "/api/states", undefined, userToken);
  const trackerEntity2 = statesRes2.data.find((e: any) => e.entity_id.includes(username));
  assert(Boolean(trackerEntity2), "Tracker entity not found");
  assert(Math.abs(trackerEntity2.latitude - 37.783300) < 0.0001, `Lat mismatch: ${trackerEntity2.latitude}`);
  assert(Math.abs(trackerEntity2.longitude - -122.416700) < 0.0001, `Lon mismatch: ${trackerEntity2.longitude}`);
  assert(trackerEntity2.attributes.battery_level === 84, "Battery mismatch");
  assert(trackerEntity2.attributes.charging === true, "Charging mismatch");
  assert(trackerEntity2.attributes.platform === "Traccar", "Platform should be Traccar");
  console.log("✓ EntityState contains exact coordinates and telemetry from Traccar.");

  // 7. Verify Repeated Traccar Updates Do NOT Create Duplicate Devices
  console.log("\n[TEST 7] Sending repeated Traccar updates and verifying single device identity...");
  for (let i = 1; i <= 3; i++) {
    await makeRequest(
      "POST",
      `/api/traccar/${traccarToken}`,
      {
        id: username,
        lat: (37.783300 + i * 0.001).toFixed(6),
        lon: (-122.416700 + i * 0.001).toFixed(6),
        timestamp: (fixSeconds + i * 10).toString(),
        batt: (84 - i).toString()
      },
      undefined,
      { "Content-Type": "application/x-www-form-urlencoded" }
    );
  }

  const devicesRes = await makeRequest("GET", "/api/devices", undefined, userToken);
  assert(devicesRes.status === 200 && Array.isArray(devicesRes.data), "Failed to fetch devices");
  const matchingTrackers = devicesRes.data.filter((d: any) => d.entity_id.includes(username));
  assert(matchingTrackers.length === 1, `Expected exactly 1 device identity for user, found ${matchingTrackers.length}`);
  console.log(`✓ Confirmed exactly 1 device identity exists for the user after multiple Traccar telemetry updates.`);

  // 8. Verify Location History Query Returns Traccar Fixes with Preserved Timestamps
  console.log("\n[TEST 8] Querying /api/history/period to verify Traccar location points...");
  const histRes = await makeRequest("GET", "/api/history/period", undefined, userToken);
  assert(histRes.status === 200 && Array.isArray(histRes.data), "Failed to fetch history");
  assert(histRes.data.length >= 4, `Expected at least 4 history points, got ${histRes.data.length}`);
  const expectedFirstFixIso = new Date(fixSeconds * 1000).toISOString();
  const firstFixEntry = histRes.data.find((h: any) => Math.abs(h.latitude - 37.783300) < 0.0001);
  assert(Boolean(firstFixEntry), "First Traccar fix missing from history");
  assert(firstFixEntry.timestamp === expectedFirstFixIso, `Timestamp mismatch: expected ${expectedFirstFixIso}, got ${firstFixEntry.timestamp}`);
  console.log(`✓ Location history correctly stored Traccar points with original timestamps.`);

  // 9. Verify Low Battery Alert from Traccar Telemetry
  console.log("\n[TEST 9] Sending low battery (14%) via Traccar to verify alert generation...");
  const circlesRes = await makeRequest("GET", "/api/circles", undefined, userToken);
  const circleId = circlesRes.data[0].id;

  // Create a second member in the circle to receive circle alerts
  const member2Name = `member2_${timestamp}`;
  const regRes2 = await makeRequest("POST", "/api/auth/register", {
    username: member2Name,
    password: password,
    display_name: "Circle Peer"
  });
  const userToken2 = regRes2.data.access_token;
  // Join the circle
  const inviteCodeRes = await makeRequest("GET", `/api/circles/${circleId}`, undefined, userToken);
  const inviteCode = inviteCodeRes.data?.invite_code;
  if (inviteCode) {
    await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, userToken2);
  }

  await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: "37.786300",
      lon: "-122.413700",
      timestamp: (fixSeconds + 60).toString(),
      batt: "14" // Low battery threshold <= 15%
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  const alertsRes = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, userToken2);
  assert(alertsRes.status === 200 && Array.isArray(alertsRes.data), "Failed to fetch alerts");
  const lowBattAlert = alertsRes.data.find((a: any) => a.alert_type === "low_battery" && a.target_user_id === regRes.data.user?.id);
  assert(Boolean(lowBattAlert), "Low battery alert was not created from Traccar telemetry");
  console.log(`✓ Low battery alert generated correctly from Traccar telemetry: '${lowBattAlert.title}'.`);

  console.log("\n================================================================================");
  console.log("ALL COMPANION REMOVAL & TRACCAR VERIFICATION TESTS PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runCompanionRemovalVerification().catch((err) => {
  console.error("\n❌ Test Suite Failed:", err);
  process.exit(1);
});
