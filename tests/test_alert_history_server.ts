import http from "http";

const BASE_URL = "http://127.0.0.1:3000";

async function makeRequest(
  method: string,
  pathStr: string,
  body?: any,
  token?: string
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, BASE_URL);
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
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
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 500, data: parsed });
        });
      }
    );

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runAlertHistoryTests() {
  console.log("Starting Real In-App Alert History Integration Test Suite...");

  const testId = Date.now();

  // 1. Authenticate User 1 (Admin/Recipient)
  const login1 = await makeRequest("POST", "/api/auth/login", {
    username: "admin@yimly.home",
    password: "password"
  });
  if (login1.status !== 200) {
    throw new Error(`Login failed for user 1: ${JSON.stringify(login1.data)}`);
  }
  const token1 = login1.data.access_token;
  const user1Id = login1.data.user.id;
  console.log("✓ User 1 authenticated successfully");

  // 2. Register and Authenticate User 2
  const user2Name = `u2_alerts_${testId}`;
  const reg2 = await makeRequest("POST", "/api/auth/register", {
    username: user2Name,
    password: "password123",
    display_name: "User Two"
  });
  if (reg2.status !== 200) {
    throw new Error(`Registration failed for user 2: ${JSON.stringify(reg2.data)}`);
  }
  const login2 = await makeRequest("POST", "/api/auth/login", {
    username: user2Name,
    password: "password123"
  });
  const token2 = login2.data.access_token;
  const user2Id = login2.data.user.id;
  console.log("✓ User 2 registered & authenticated");

  // 3. Create Circle One (User 1 is owner)
  const circle1Res = await makeRequest("POST", "/api/circles", { name: "Alerts Test Circle" }, token1);
  const circle1Id = circle1Res.data.id;
  const inviteCode = circle1Res.data.invite_code;
  console.log(`✓ Circle One created (ID: ${circle1Id})`);

  // 4. User 2 joins Circle One
  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, token2);
  if (joinRes.status !== 200) {
    throw new Error("User 2 failed to join Circle One");
  }
  console.log("✓ User 2 joined Circle One");

  // TEST 1: Empty alert history loads correctly
  const emptyAlerts = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token1);
  if (emptyAlerts.status !== 200 || !Array.isArray(emptyAlerts.data) || emptyAlerts.data.length !== 0) {
    throw new Error(`Expected empty list of alerts for fresh circle, got: ${JSON.stringify(emptyAlerts.data)}`);
  }
  console.log("✓ Test 1: Empty alert history loads correctly with HTTP 200 (Passed)");

  // TEST 2: Trigger multiple real alert types and verify fields
  // Setup User 2's device and trigger alerts:
  // a) Low battery transition
  const u2PhoneEntity = `device_tracker.u2_phone_${testId}`;

  // First sample at 50%
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 50
  }, token2);

  // Transition to 10% (triggers low battery alert)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 10
  }, token2);

  // b) Offline transition
  // Move time backwards and evaluate offline checker
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: u2PhoneEntity,
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // Fetch loaded alerts for User 1 in Circle One
  const fetchedAlerts = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token1);
  if (fetchedAlerts.status !== 200 || fetchedAlerts.data.length !== 2) {
    throw new Error(`Expected exactly 2 alerts triggered, got: ${fetchedAlerts.data.length}`);
  }

  // TEST 3: Newest alerts appear first (Verify created_at sorted descending)
  const lowBatteryAlert = fetchedAlerts.data.find((a: any) => a.alert_type === "low_battery");
  const offlineAlert = fetchedAlerts.data.find((a: any) => a.alert_type === "device_offline");

  if (!lowBatteryAlert || !offlineAlert) {
    throw new Error(`Expected to find both alert types, got: ${JSON.stringify(fetchedAlerts.data)}`);
  }

  const firstIsNewer = new Date(fetchedAlerts.data[0].created_at).getTime() >= new Date(fetchedAlerts.data[1].created_at).getTime();
  if (!firstIsNewer) {
    throw new Error("Alerts are not ordered with newest first!");
  }
  console.log("✓ Test 3: Newest alerts appear first sorted by created_at (Passed)");

  // TEST 4: Tapping unread alert marks it read (PUT endpoint)
  const alertToRead = fetchedAlerts.data[0];
  if (alertToRead.read === true) {
    throw new Error("Expected initial alert to be unread, but was already read!");
  }

  const markReadRes = await makeRequest("PUT", `/api/circles/${circle1Id}/alerts/${alertToRead.id}/read`, {}, token1);
  if (markReadRes.status !== 200 || markReadRes.data.read !== true) {
    throw new Error(`Failed to mark alert as read: ${JSON.stringify(markReadRes.data)}`);
  }

  // Re-fetch and check
  const reFetchedAlerts = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token1);
  const updatedAlert = reFetchedAlerts.data.find((a: any) => a.id === alertToRead.id);
  if (!updatedAlert || updatedAlert.read !== true) {
    throw new Error("Alert status was not persisted as read in database!");
  }
  console.log("✓ Test 4: Marking alert read persisted correctly in database (Passed)");

  // TEST 5: Circle isolation & authorization
  // Create User 3 (separate circle)
  const user3Name = `u3_alerts_${testId}`;
  await makeRequest("POST", "/api/auth/register", {
    username: user3Name,
    password: "password123",
    display_name: "User Three"
  });
  const login3 = await makeRequest("POST", "/api/auth/login", {
    username: user3Name,
    password: "password123"
  });
  const token3 = login3.data.access_token;

  // Try to access Circle One alerts using User 3's token (should be rejected with HTTP 403 Forbidden)
  const forbiddenRes = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token3);
  if (forbiddenRes.status !== 403) {
    throw new Error(`Expected HTTP 403 Forbidden for cross-circle access, got: ${forbiddenRes.status}`);
  }

  // Try to mark Circle One alert as read using User 3's token (should be rejected with HTTP 403 Forbidden)
  const forbiddenPutRes = await makeRequest("PUT", `/api/circles/${circle1Id}/alerts/${alertToRead.id}/read`, {}, token3);
  if (forbiddenPutRes.status !== 403) {
    throw new Error(`Expected HTTP 403 Forbidden for cross-circle mark read action, got: ${forbiddenPutRes.status}`);
  }
  console.log("✓ Test 5: Strict Circle Isolation & Access Authorization verified (Passed)");

  // TEST 6: Location and private telemetry leakage validation
  const privacyAlert = fetchedAlerts.data[0];
  const payloadStr = JSON.stringify(privacyAlert);
  if (payloadStr.includes("latitude") || payloadStr.includes("longitude") || payloadStr.includes("gps") || payloadStr.includes("accuracy") || payloadStr.includes("secret")) {
    throw new Error(`Privacy breach! Raw location or private credentials leaked in Alert payload: ${payloadStr}`);
  }
  console.log("✓ Test 6: Zero location, private sensor, or authentication data leakage in alert payloads (Passed)");

  console.log("\nALL REAL IN-APP ALERT HISTORY TESTS PASSED SUCCESSFULLY! 🎉");
}

runAlertHistoryTests().catch((err) => {
  console.error("Alert History Test Suite Failed:", err);
  process.exit(1);
});
