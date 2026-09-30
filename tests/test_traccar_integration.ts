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

async function runTraccarIntegrationTests() {
  console.log("================================================================================");
  console.log("RUNNING TRACCAR CLIENT LOCATION SOURCE INTEGRATION & AUDIT TEST SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();
  const username = `traccar_user_${timestamp}`;
  const password = "TraccarPass123!";
  const displayName = "Traccar Test User";

  // 1. User Account Setup & Initial Provisioning
  console.log("\n[TEST 1] Creating Yimly user account and verifying Traccar device provisioning...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: displayName
  });
  assert(regRes.status === 200, `Registration failed: ${JSON.stringify(regRes.data)}`);
  const userToken = regRes.data.access_token;
  assert(Boolean(userToken), "Access token missing in registration response");
  console.log(`✓ User '${username}' registered successfully.`);

  // 2. Query Traccar Config
  console.log("\n[TEST 2] Fetching Traccar Client configuration for the user...");
  const configRes = await makeRequest("GET", "/api/traccar/config", undefined, userToken);
  assert(configRes.status === 200, `Traccar config failed: ${JSON.stringify(configRes.data)}`);
  assert(configRes.data.device_id === username, `Expected device_id '${username}', got '${configRes.data.device_id}'`);
  assert(Boolean(configRes.data.token), "Expected non-empty Traccar token");
  assert(configRes.data.server_url.includes(`/api/traccar/${configRes.data.token}`), "Expected server_url containing token path");
  const traccarToken = configRes.data.token;
  console.log(`✓ Traccar device configured with token: ${traccarToken}`);
  console.log(`✓ Server URL: ${configRes.data.server_url}`);

  // 3. Invalid Token Rejection
  console.log("\n[TEST 3] Verifying rejection of invalid / unknown Traccar token...");
  const badTokenRes = await makeRequest(
    "POST",
    "/api/traccar/completely_bogus_token_12345",
    { id: username, lat: "37.7749", lon: "-122.4194" },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(badTokenRes.status === 404 || badTokenRes.status === 401, `Expected 404/401 for bad token, got ${badTokenRes.status}`);
  console.log("✓ Invalid token rejected with HTTP 404/401.");

  // 4. Device ID Mismatch Rejection
  console.log("\n[TEST 4] Verifying rejection when Traccar Device ID does not match Yimly username...");
  const mismatchRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    { id: "wrong_other_user", lat: "37.7749", lon: "-122.4194" },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(mismatchRes.status === 400 || mismatchRes.status === 403, `Expected 400/403 for mismatched username, got ${mismatchRes.status}`);
  console.log("✓ Device ID mismatch rejected with HTTP 400.");

  // 5. Invalid Latitude Rejection
  console.log("\n[TEST 5] Verifying rejection of out-of-bounds latitude (> 90 or < -90)...");
  const badLatRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    { id: username, lat: "98.5432", lon: "-122.4194" },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(badLatRes.status === 400, `Expected 400 for latitude 98.5432, got ${badLatRes.status}`);
  console.log("✓ Invalid latitude rejected with HTTP 400.");

  // 6. Invalid Longitude Rejection
  console.log("\n[TEST 6] Verifying rejection of out-of-bounds longitude (> 180 or < -180)...");
  const badLonRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    { id: username, lat: "37.7749", lon: "-195.1234" },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(badLonRes.status === 400, `Expected 400 for longitude -195.1234, got ${badLonRes.status}`);
  console.log("✓ Invalid longitude rejected with HTTP 400.");

  // 7. Valid Traccar Form-Urlencoded Location & Units Conversion (Knots -> m/s, Seconds -> UTC)
  console.log("\n[TEST 7] Sending valid Traccar form-urlencoded payload and checking units conversion...");
  const fixSeconds = Math.floor(Date.now() / 1000) + 1; // Current Unix seconds epoch
  const speedKnots = 10.0; // 10 knots = ~5.14 m/s
  const validFormRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: "37.774929",
      lon: "-122.419416",
      timestamp: fixSeconds.toString(),
      accuracy: "12.5",
      altitude: "45.0",
      speed: speedKnots.toString(),
      bearing: "180.0",
      batt: "87",
      charge: "true"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(validFormRes.status === 200, `Expected 200 for valid Traccar post, got ${validFormRes.status}: ${JSON.stringify(validFormRes.data)}`);
  assert(validFormRes.data.success === true, "Expected success: true");
  assert(Math.abs(validFormRes.data.diagnostics.speedMps - 5.14) < 0.05, `Expected ~5.14 m/s from 10 knots, got ${validFormRes.data.diagnostics.speedMps}`);
  console.log("✓ Valid form-urlencoded request processed with HTTP 200.");
  console.log(`✓ Knots to m/s conversion verified: 10.0 knots -> ${validFormRes.data.diagnostics.speedMps} m/s.`);

  // 8. Verify EntityState Attributes & Battery / Charging
  console.log("\n[TEST 8] Verifying EntityState updated with correct coordinates, speed, battery, and charging...");
  const statesRes = await makeRequest("GET", "/api/states", undefined, userToken);
  assert(statesRes.status === 200 && Array.isArray(statesRes.data), "Failed to fetch entity states");
  const trackerEntity = statesRes.data.find((e: any) => e.entity_id.includes(username));
  assert(Boolean(trackerEntity), `Device tracker entity for ${username} not found in /api/states`);
  assert(Math.abs(trackerEntity.latitude - 37.774929) < 0.0001, `Latitude mismatch: ${trackerEntity.latitude}`);
  assert(Math.abs(trackerEntity.longitude - -122.419416) < 0.0001, `Longitude mismatch: ${trackerEntity.longitude}`);
  assert(trackerEntity.attributes.battery_level === 87, `Battery mismatch: ${trackerEntity.attributes.battery_level}`);
  assert(trackerEntity.attributes.charging === true, "Charging state mismatch");
  assert(trackerEntity.attributes.platform === "Traccar", `Platform mismatch: ${trackerEntity.attributes.platform}`);
  console.log("✓ EntityState contains accurate Traccar telemetry attributes.");

  // 9. Valid Query-Parameter Location Variant
  console.log("\n[TEST 9] Testing query-parameter variant of Traccar location update...");
  const querySeconds = fixSeconds + 60;
  const queryRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}?id=${encodeURIComponent(username)}&lat=37.775500&lon=-122.418000&timestamp=${querySeconds}&speed=2.0&batt=85&charge=false`
  );
  assert(queryRes.status === 200, `Expected 200 for query-param Traccar post, got ${queryRes.status}`);
  console.log("✓ Query-parameter request processed with HTTP 200.");

  // 10. Missing Coordinates / Heartbeat Handling
  console.log("\n[TEST 10] Testing heartbeat update without coordinates (must preserve existing valid coordinates)...");
  const heartbeatSeconds = querySeconds + 30;
  const heartbeatRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      timestamp: heartbeatSeconds.toString(),
      batt: "82",
      charge: "true"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(heartbeatRes.status === 200, `Heartbeat failed: ${heartbeatRes.status}`);

  const statesAfterHeartbeat = await makeRequest("GET", "/api/states", undefined, userToken);
  const trackerAfterHeartbeat = statesAfterHeartbeat.data.find((e: any) => e.entity_id.includes(username));
  assert(Math.abs(trackerAfterHeartbeat.latitude - 37.775500) < 0.0001, "Heartbeat corrupted latitude!");
  assert(Math.abs(trackerAfterHeartbeat.longitude - -122.418000) < 0.0001, "Heartbeat corrupted longitude!");
  assert(trackerAfterHeartbeat.attributes.battery_level === 82, "Heartbeat failed to update battery");
  assert(trackerAfterHeartbeat.attributes.charging === true, "Heartbeat failed to update charging");
  console.log("✓ Heartbeat successfully updated battery/charging without destroying valid coordinates.");

  // 11. Buffered Historical Location Rule (Old location must NOT move current pin backwards)
  console.log("\n[TEST 11] Testing offline buffer dump rule: old buffered location must NOT overwrite newer current state...");
  const oldBufferedSeconds = fixSeconds - 3600; // 1 hour in the past!
  const oldBufferedLat = 37.700000;
  const oldBufferedLon = -122.400000;

  const oldFixRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: oldBufferedLat.toString(),
      lon: oldBufferedLon.toString(),
      timestamp: oldBufferedSeconds.toString(),
      batt: "95"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(oldFixRes.status === 200, `Old fix request failed: ${oldFixRes.status}`);

  const statesAfterOldFix = await makeRequest("GET", "/api/states", undefined, userToken);
  const trackerAfterOldFix = statesAfterOldFix.data.find((e: any) => e.entity_id.includes(username));
  assert(Math.abs(trackerAfterOldFix.latitude - 37.775500) < 0.0001, "Old buffered location moved current map marker backwards!");
  console.log("✓ Current map pin remained at newer coordinate (did not move backwards).");

  // 12. Historical Location Uses Original Traccar Timestamp
  console.log("\n[TEST 12] Verifying LocationHistory recorded the buffered point with its original past timestamp...");
  const histRes = await makeRequest("GET", "/api/history/period", undefined, userToken);
  assert(histRes.status === 200 && Array.isArray(histRes.data), "Failed to fetch history");
  const recordedOldPoint = histRes.data.find((h: any) => Math.abs(h.latitude - oldBufferedLat) < 0.0001);
  assert(Boolean(recordedOldPoint), "Old buffered point missing from LocationHistory!");
  const expectedOldIso = new Date(oldBufferedSeconds * 1000).toISOString();
  assert(recordedOldPoint.timestamp === expectedOldIso, `Expected timestamp ${expectedOldIso}, got ${recordedOldPoint.timestamp}`);
  console.log(`✓ LocationHistory retained the exact Traccar fix timestamp: ${recordedOldPoint.timestamp}.`);

  // 13. WebSocket State Broadcast Pipeline
  console.log("\n[TEST 13] Testing live WebSocket state broadcast upon incoming Traccar telemetry...");
  let wsReadyResolve: () => void;
  const wsReadyPromise = new Promise<void>((resolve) => {
    wsReadyResolve = resolve;
  });

  const wsReceivedPromise = new Promise<{ entity_id: string; new_state: any }>((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:3000/api/websocket");
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket state_changed event timeout"));
    }, 6000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", access_token: userToken }));
    });

    ws.on("message", (dataStr) => {
      try {
        const msg = JSON.parse(dataStr.toString());
        if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ id: 101, type: "subscribe_events", event_type: "state_changed" }));
          // Give subscription a moment to register on the server
          setTimeout(() => wsReadyResolve(), 100);
        } else if (msg.type === "event" && msg.event?.data?.entity_id?.includes(username)) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.event.data);
        }
      } catch {}
    });
  });

  await wsReadyPromise;

  // Send a fresh new location to trigger the broadcast
  const liveSeconds = querySeconds + 300;
  await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: "37.778800",
      lon: "-122.415500",
      timestamp: liveSeconds.toString(),
      batt: "80"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  const wsEvent = await wsReceivedPromise;
  assert(Math.abs(wsEvent.new_state.latitude - 37.778800) < 0.0001, "WebSocket received incorrect latitude");
  console.log(`✓ WebSocket state_changed event received in real-time for '${wsEvent.entity_id}'.`);

  // 14. Family Circle Map / Members Endpoint Integration
  console.log("\n[TEST 14] Verifying Family Circle members endpoint returns Traccar device and coordinates...");
  const circlesRes = await makeRequest("GET", "/api/circles", undefined, userToken);
  assert(circlesRes.status === 200 && Array.isArray(circlesRes.data) && circlesRes.data.length > 0, "No circles found");
  const circleId = circlesRes.data[0].id;

  const membersRes = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, userToken);
  assert(membersRes.status === 200 && Array.isArray(membersRes.data), "Failed to fetch circle members");
  const memberObj = membersRes.data.find((m: any) => m.username === username);
  assert(Boolean(memberObj), `User ${username} not found in circle members`);
  assert(Array.isArray(memberObj.devices) && memberObj.devices.length > 0, "No devices returned for member in circle");
  const memberDevice = memberObj.devices[0];
  assert(Math.abs(memberDevice.latitude - 37.778800) < 0.0001, `Circle map device latitude mismatch: ${memberDevice.latitude}`);
  assert(Math.abs(memberDevice.longitude - -122.415500) < 0.0001, `Circle map device longitude mismatch: ${memberDevice.longitude}`);
  console.log(`✓ Family Circle member device coordinates verified on map: lat=${memberDevice.latitude}, lon=${memberDevice.longitude}.`);

  // 15. Non-Traccar Functionality Unaffected
  console.log("\n[TEST 15] Verifying non-Traccar functionality (circles, places, profile, alerts) remains completely unaffected...");
  const placesRes = await makeRequest("GET", `/api/circles/${circleId}/places`, undefined, userToken);
  assert(placesRes.status === 200, "Places API broken");
  const alertsRes = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, userToken);
  assert(alertsRes.status === 200, "Alerts API broken");
  const meRes = await makeRequest("GET", "/api/auth/me", undefined, userToken);
  assert(meRes.status === 200 && meRes.data.username === username, "Profile /auth/me broken");
  console.log("✓ Existing non-Traccar endpoints operate normally.");

  console.log("\n================================================================================");
  console.log("ALL 15 TRACCAR CLIENT INTEGRATION TESTS PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runTraccarIntegrationTests().catch((err) => {
  console.error("\n❌ Traccar Integration Test Suite Failed:", err);
  process.exit(1);
});
