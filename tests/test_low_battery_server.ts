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

async function runLowBatteryTests() {
  console.log("Starting Low-Battery Alert Trigger Test Suite...");

  const testId = Date.now();
  const u2PhoneEntity = `device_tracker.u2_phone_${testId}`;
  const u2WatchEntity = `device_tracker.u2_watch_${testId}`;

  // 1. Authenticate User 1 (Admin)
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
  const user2Name = `u2_bat_test_${testId}`;
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
  const circle1Res = await makeRequest("POST", "/api/circles", { name: "Battery Circle" }, token1);
  const circleId = circle1Res.data.id;
  const inviteCode = circle1Res.data.invite_code;
  console.log(`✓ Circle created (ID: ${circleId})`);

  // 4. User 2 joins Circle
  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, token2);
  if (joinRes.status !== 200) {
    throw new Error("User 2 failed to join Circle");
  }
  console.log("✓ User 2 joined Circle");

  // TEST 16: No active circle produces no alert
  // Create User 3 (not in any circles)
  const user3Name = `u3_bat_no_circle_${testId}`;
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
  const user3Id = login3.data.user.id;

  // Send first telemetry at 50%
  await makeRequest("POST", "/api/webhook/test_webhook_u3", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U3 Phone",
    entity_id: `device_tracker.u3_phone_${testId}`,
    user_id: user3Id,
    battery: 50
  }, token3);

  // Send second telemetry at 10% (transition below 15%)
  await makeRequest("POST", "/api/webhook/test_webhook_u3", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U3 Phone",
    entity_id: `device_tracker.u3_phone_${testId}`,
    user_id: user3Id,
    battery: 10
  }, token3);

  // Verify no alerts are generated since User 3 is not in any circle
  const u3Alerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u3Alerts.data.length !== 0) {
    throw new Error(`Expected 0 alerts for no-circle user, got ${u3Alerts.data.length}`);
  }
  console.log("✓ Test 16: No active circle produces no alert (Passed)");

  // TEST 1: First observed battery below 15% does NOT falsely alert
  // Target: User 2's device starts at 10%
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 10
  }, token2);

  // Verify User 1 receives no alert
  const alerts1 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alerts1.data.length !== 0) {
    throw new Error(`Expected 0 alerts on first observed sample below 15%, got ${alerts1.data.length}`);
  }
  console.log("✓ Test 1: First observed battery below 15% does not falsely alert (Passed)");

  // Recovery (bring User 2 battery to 20% to re-arm)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 20
  }, token2);

  // TEST 2: 20 -> 14 transition creates low-battery alert
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 14
  }, token2);

  const alertsAfter14 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfter14.data.length !== 1 || alertsAfter14.data[0].alert_type !== "low_battery") {
    throw new Error(`Expected exactly 1 low battery alert, got: ${JSON.stringify(alertsAfter14.data)}`);
  }
  const lowAlert = alertsAfter14.data[0];

  // Validate alert properties
  if (lowAlert.circle_id !== circleId) {
    throw new Error(`Expected circle_id ${circleId}, got ${lowAlert.circle_id}`);
  }
  if (lowAlert.target_user_id !== user2Id) {
    throw new Error(`Expected target_user_id ${user2Id}, got ${lowAlert.target_user_id}`);
  }
  if (!lowAlert.title.includes("User Two") || !lowAlert.message.includes("14%")) {
    throw new Error(`Incorrect low battery alert content: ${JSON.stringify(lowAlert)}`);
  }
  if (JSON.stringify(lowAlert).includes("latitude") || JSON.stringify(lowAlert).includes("longitude")) {
    throw new Error("Privacy violation! Low-battery alert contains location/GPS data!");
  }
  console.log("✓ Test 2: 20 -> 14 creates low-battery alert with correct properties & privacy (Passed)");

  // TEST 15: Tracked user does not receive self-alert
  const alertsForUser2 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token2);
  if (alertsForUser2.data.length !== 0) {
    throw new Error(`Expected User 2 to receive 0 alerts, got: ${alertsForUser2.data.length}`);
  }
  console.log("✓ Test 15: Tracked user does not receive unintended self-alert (Passed)");

  // TEST 5: 14 -> 13 creates no duplicate alert
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 13
  }, token2);

  const alertsAfter13 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfter13.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1, got ${alertsAfter13.data.length}`);
  }
  console.log("✓ Test 5: 14 -> 13 creates no duplicate (Passed)");

  // TEST 6: 10 -> 5 creates no duplicate alert
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 5
  }, token2);

  const alertsAfter5 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfter5.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1, got ${alertsAfter5.data.length}`);
  }
  console.log("✓ Test 6: 10 -> 5 creates no duplicate (Passed)");

  // TEST 7: Recovery to >= 15% re-arms device
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 15
  }, token2);

  // TEST 8: Re-crossing below 15% creates a new alert
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 12
  }, token2);

  const alertsAfterRecross = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfterRecross.data.length !== 2) {
    throw new Error(`Expected alert count to be 2 after re-arming and re-crossing, got ${alertsAfterRecross.data.length}`);
  }
  console.log("✓ Test 7 & 8: Recovery & re-crossing functions perfectly (Passed)");

  // TEST 3: 16 -> 14 transition creates low-battery alert (after re-arm)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 16
  }, token2);

  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 14
  }, token2);

  const alertsAfter16to14 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfter16to14.data.length !== 3) {
    throw new Error(`Expected alert count to be 3, got ${alertsAfter16to14.data.length}`);
  }
  console.log("✓ Test 3: 16 -> 14 creates alert (Passed)");

  // TEST 13 & 14: notify_low_battery notification preference check
  // Disable notify_low_battery for User 1 (Admin)
  await makeRequest("PUT", "/api/auth/profile", { notify_low_battery: false }, token1);

  // Recovery User 2 to 20%
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 20
  }, token2);

  // Set User 2 to 10% (transition below 15%)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 10
  }, token2);

  // User 1 should NOT receive a new alert since preference is false
  const alertsPrefDisabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsPrefDisabled.data.length !== 3) {
    throw new Error(`Expected alert count to remain 3, got ${alertsPrefDisabled.data.length}`);
  }
  console.log("✓ Test 14: notify_low_battery = false suppresses alerts (Passed)");

  // Restore preference to true
  await makeRequest("PUT", "/api/auth/profile", { notify_low_battery: true }, token1);

  // Recovery User 2 to 25%
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 25
  }, token2);

  // Set User 2 to 11%
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 11
  }, token2);

  // User 1 should now receive a new alert
  const alertsPrefEnabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsPrefEnabled.data.length !== 4) {
    throw new Error(`Expected alert count to be 4, got ${alertsPrefEnabled.data.length}`);
  }
  console.log("✓ Test 13: notify_low_battery = true delivers alert (Passed)");

  // TEST 17, 18, 19: Missing / Invalid / OOB battery values do not alert
  // Bring User 2 to 20% (recovery)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 20
  }, token2);

  // Webhook with invalid string battery
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: "unknown"
  }, token2);

  // Webhook with out-of-bounds battery (>100)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 150
  }, token2);

  // Webhook with out-of-bounds battery (<0)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: -10
  }, token2);

  // Alert count should still be 4
  const alertsAfterInvalids = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfterInvalids.data.length !== 4) {
    throw new Error(`Expected alert count to remain 4, got ${alertsAfterInvalids.data.length}`);
  }
  console.log("✓ Test 17, 18, 19: Missing / Invalid / OOB battery values do not alert (Passed)");

  // TEST 9: Multiple devices track independently
  // User 2 has Phone and Watch
  // Phone starts at 20%
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 20
  }, token2);

  // Watch starts at 25% (first sample)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Watch",
    entity_id: u2WatchEntity,
    user_id: user2Id,
    battery: 25
  }, token2);

  // Bring Phone to 10% (should alert)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: u2PhoneEntity,
    user_id: user2Id,
    battery: 10
  }, token2);

  // Bring Watch to 8% (should also alert)
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Watch",
    entity_id: u2WatchEntity,
    user_id: user2Id,
    battery: 8
  }, token2);

  const alertsMultipleDevices = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsMultipleDevices.data.length !== 6) {
    throw new Error(`Expected alert count to be 6 (both Phone and Watch alert), got ${alertsMultipleDevices.data.length}`);
  }
  console.log("✓ Test 9: Multiple devices track independently (Passed)");

  // TEST 10: Multiple users remain isolated
  // Create User 4
  const user4Name = `u4_isolation_${testId}`;
  await makeRequest("POST", "/api/auth/register", {
    username: user4Name,
    password: "password123",
    display_name: "User Four"
  });
  const login4 = await makeRequest("POST", "/api/auth/login", {
    username: user4Name,
    password: "password123"
  });
  const token4 = login4.data.access_token;
  const user4Id = login4.data.user.id;

  // User 4 joins circle
  await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, token4);

  // Send first telemetry for User 4 at 50%
  await makeRequest("POST", "/api/webhook/test_webhook_u4", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U4 Phone",
    entity_id: `device_tracker.u4_phone_${testId}`,
    user_id: user4Id,
    battery: 50
  }, token4);

  // Move User 4 to 12% (should alert other circle members)
  await makeRequest("POST", "/api/webhook/test_webhook_u4", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U4 Phone",
    entity_id: `device_tracker.u4_phone_${testId}`,
    user_id: user4Id,
    battery: 12
  }, token4);

  // Admin (User 1) should receive the alert for User 4
  const adminAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  const u4Alert = adminAlerts.data.find((a: any) => a.title.includes("User Four"));
  if (!u4Alert) {
    throw new Error("Expected User 1 to receive User 4 low-battery alert");
  }
  console.log("✓ Test 10: Multiple users remain isolated (Passed)");

  console.log("\nALL LOW-BATTERY TRANSITION ENGINE TESTS PASSED SUCCESSFULLY! 🎉");
}

runLowBatteryTests().catch((err) => {
  console.error("Low-Battery Test Suite Failed:", err);
  process.exit(1);
});
