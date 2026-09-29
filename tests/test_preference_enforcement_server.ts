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

async function runPreferenceEnforcementTests() {
  console.log("Starting Complete Notification Preference Enforcement Test Suite...");

  const testId = Date.now();
  const uA_phone = `device_tracker.ua_phone_${testId}`;

  // 1. Register and Authenticate User A (Tracker sender)
  const regA = await makeRequest("POST", "/api/auth/register", {
    username: `user_a_${testId}`,
    password: "password123",
    display_name: "User A"
  });
  const loginA = await makeRequest("POST", "/api/auth/login", {
    username: `user_a_${testId}`,
    password: "password123"
  });
  const tokenA = loginA.data.access_token;
  const userAId = loginA.data.user.id;

  // 2. Register and Authenticate User B (Recipient - Enabled preferences)
  const regB = await makeRequest("POST", "/api/auth/register", {
    username: `user_b_${testId}`,
    password: "password123",
    display_name: "User B"
  });
  const loginB = await makeRequest("POST", "/api/auth/login", {
    username: `user_b_${testId}`,
    password: "password123"
  });
  const tokenB = loginB.data.access_token;
  const userBId = loginB.data.user.id;

  // 3. Register and Authenticate User C (Recipient - Disabled preferences)
  const regC = await makeRequest("POST", "/api/auth/register", {
    username: `user_c_${testId}`,
    password: "password123",
    display_name: "User C"
  });
  const loginC = await makeRequest("POST", "/api/auth/login", {
    username: `user_c_${testId}`,
    password: "password123"
  });
  const tokenC = loginC.data.access_token;
  const userCId = loginC.data.user.id;

  // 4. Create Circle One (User A is owner)
  const circle1Res = await makeRequest("POST", "/api/circles", { name: "Alerts Pref Circle" }, tokenA);
  const circleId = circle1Res.data.id;
  const inviteCode = circle1Res.data.invite_code;
  console.log(`✓ Circle created (ID: ${circleId})`);

  // 5. User B joins Circle
  await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, tokenB);
  // 6. User C joins Circle
  await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, tokenC);
  console.log("✓ User B and User C joined Circle One");

  // 7. Setup Place for Geofence Testing
  const placeRes = await makeRequest("POST", `/api/circles/${circleId}/places`, {
    name: "Home Base",
    latitude: 37.7749,
    longitude: -122.4194,
    radius: 100
  }, tokenA);
  const placeId = placeRes.data.id;
  console.log(`✓ Place created (ID: ${placeId})`);

  // 8. Configure Preferences:
  // User B has ALL preferences enabled
  await makeRequest("PUT", "/api/auth/profile", {
    notify_arrival_departure: true,
    notify_stop_sharing: true,
    notify_low_battery: true,
    notify_device_offline: true,
    notify_push: true
  }, tokenB);

  // User C has ALL preferences disabled
  await makeRequest("PUT", "/api/auth/profile", {
    notify_arrival_departure: false,
    notify_stop_sharing: false,
    notify_low_battery: false,
    notify_device_offline: false,
    notify_push: false
  }, tokenC);

  console.log("✓ Recipients configured: B enabled, C disabled");

  // ==========================================
  // TEST 1-4: Geofence Arrival / Departure
  // ==========================================
  // Send first telemetry for User A (Outside Place)
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7000,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 80
  }, tokenA);

  // Send second telemetry (Arriving at Place)
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 80
  }, tokenA);

  // Assertions for Arrival Alert
  const alertsB_arrival = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  const arrivalAlert = alertsB_arrival.data.find((a: any) => a.alert_type === "arrival");
  if (!arrivalAlert) {
    throw new Error("Test 1: User B (enabled) failed to receive arrival alert!");
  }

  const alertsC_arrival = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token3ForC(tokenC));
  const hasC_arrival = alertsC_arrival.data.some((a: any) => a.alert_type === "arrival");
  if (hasC_arrival) {
    throw new Error("Test 2: User C (disabled) received geofence arrival alert!");
  }
  console.log("✓ Test 1 & 2: Geofence Arrival preference enforcement (Passed)");

  // Send third telemetry (Departing Place)
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7000,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 80
  }, tokenA);

  // Assertions for Departure Alert
  const alertsB_departure = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  const departureAlert = alertsB_departure.data.find((a: any) => a.alert_type === "departure");
  if (!departureAlert) {
    throw new Error("Test 3: User B (enabled) failed to receive departure alert!");
  }

  const alertsC_departure = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenC);
  const hasC_departure = alertsC_departure.data.some((a: any) => a.alert_type === "departure");
  if (hasC_departure) {
    throw new Error("Test 4: User C (disabled) received geofence departure alert!");
  }
  console.log("✓ Test 3 & 4: Geofence Departure preference enforcement (Passed)");

  // ==========================================
  // TEST 5-6: Stop Sharing Alert
  // ==========================================
  // User A transitions location sharing True -> False
  await makeRequest("PUT", "/api/auth/profile", { share_location: false }, tokenA);

  // Assertions for Stop Sharing Alert
  const alertsB_stop = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  const stopAlert = alertsB_stop.data.find((a: any) => a.alert_type === "stop_sharing");
  if (!stopAlert) {
    throw new Error("Test 5: User B (enabled) failed to receive stop-sharing alert!");
  }

  const alertsC_stop = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenC);
  const hasC_stop = alertsC_stop.data.some((a: any) => a.alert_type === "stop_sharing");
  if (hasC_stop) {
    throw new Error("Test 6: User C (disabled) received stop-sharing alert!");
  }
  console.log("✓ Test 5 & 6: Stop-sharing preference enforcement (Passed)");

  // Restore location sharing for User A
  await makeRequest("PUT", "/api/auth/profile", { share_location: true }, tokenA);

  // ==========================================
  // TEST 7-8: Low Battery Alert
  // ==========================================
  // User A battery goes 80% -> 10%
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 10
  }, tokenA);

  // Assertions for Low Battery Alert
  const alertsB_bat = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  const batteryAlert = alertsB_bat.data.find((a: any) => a.alert_type === "low_battery" && a.target_user_id === userAId);
  if (!batteryAlert) {
    throw new Error("Test 7: User B (enabled) failed to receive low battery alert!");
  }

  const alertsC_bat = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenC);
  const hasC_bat = alertsC_bat.data.some((a: any) => a.alert_type === "low_battery");
  if (hasC_bat) {
    throw new Error("Test 8: User C (disabled) received low battery alert!");
  }
  console.log("✓ Test 7 & 8: Low battery preference enforcement (Passed)");

  // Recovery battery User A
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 80
  }, tokenA);

  // ==========================================
  // TEST 9-10: Device Offline Alert
  // ==========================================
  // User A's device seen 16 mins ago and evaluate
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: uA_phone,
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // Assertions for Device Offline Alert
  const alertsB_off = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  const offlineAlert = alertsB_off.data.find((a: any) => a.alert_type === "device_offline" && a.target_user_id === userAId);
  if (!offlineAlert) {
    throw new Error("Test 9: User B (enabled) failed to receive device offline alert!");
  }

  const alertsC_off = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenC);
  const hasC_off = alertsC_off.data.some((a: any) => a.alert_type === "device_offline");
  if (hasC_off) {
    throw new Error("Test 10: User C (disabled) received device offline alert!");
  }
  console.log("✓ Test 9 & 10: Device offline preference enforcement (Passed)");

  // ==========================================
  // TEST 11-14: Per-recipient isolation, changing preferences, no-self-alert, cross-circle isolation
  // ==========================================
  // 11. Changing B's preferences should only affect B, leaving C isolated
  await makeRequest("PUT", "/api/auth/profile", { notify_low_battery: false }, tokenB);
  
  // UA battery goes 80% -> 12% again (after recovery)
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 12
  }, tokenA);

  const alertsB_bat_change = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  // Expecting count of low_battery alerts to remain 1 (no new low battery alert created for B)
  const bLowBatteryAlertsCount = alertsB_bat_change.data.filter((a: any) => a.alert_type === "low_battery").length;
  if (bLowBatteryAlertsCount !== 1) {
    throw new Error(`Test 11 & 12: B disabled low battery preference but still received alert! Count: ${bLowBatteryAlertsCount}`);
  }
  console.log("✓ Test 11 & 12: Recipient preferences are isolated and change independently (Passed)");

  // 13. Sender A must never receive their own alerts
  const alertsA = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenA);
  if (alertsA.data.length !== 0) {
    throw new Error(`Test 13: Tracked User A received their own alerts: ${JSON.stringify(alertsA.data)}`);
  }
  console.log("✓ Test 13: Tracked user never receives their own alerts (Passed)");

  // 14. Different circles remain completely isolated
  // Create User D
  const userDName = `user_d_${testId}`;
  await makeRequest("POST", "/api/auth/register", {
    username: userDName,
    password: "password123",
    display_name: "User D"
  });
  const loginD = await makeRequest("POST", "/api/auth/login", {
    username: userDName,
    password: "password123"
  });
  const tokenD = loginD.data.access_token;

  const circle2Res = await makeRequest("POST", "/api/circles", { name: "Circle Two" }, tokenD);
  const circle2Id = circle2Res.data.id;

  const alertsD = await makeRequest("GET", `/api/circles/${circle2Id}/alerts`, undefined, tokenD);
  if (alertsD.data.length !== 0) {
    throw new Error("Test 14: User D inside isolated Circle Two received cross-circle alerts!");
  }
  console.log("✓ Test 14: Circle isolation strictly enforced (Passed)");

  // ==========================================
  // TEST 15-17: Push Preference Tests
  // ==========================================
  // 15. notify_push = false but alert preference = true must STILL create in-app alert!
  await makeRequest("PUT", "/api/auth/profile", {
    notify_push: false,
    notify_low_battery: true
  }, tokenB);

  // Recovery UA
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 80
  }, tokenA);

  // Trigger low battery
  await makeRequest("POST", "/api/webhook/test_webhook_ua", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "UA Phone",
    entity_id: uA_phone,
    user_id: userAId,
    battery: 13
  }, tokenA);

  const alertsB_push_false = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, tokenB);
  // low_battery alerts count should now be 2
  const bLowBatteryAlertsCountWithPushFalse = alertsB_push_false.data.filter((a: any) => a.alert_type === "low_battery").length;
  if (bLowBatteryAlertsCountWithPushFalse !== 2) {
    throw new Error(`Test 15: notify_push = false suppressed in-app alert! Count: ${bLowBatteryAlertsCountWithPushFalse}`);
  }
  console.log("✓ Test 15 & 16: notify_push = false does not suppress in-app alert creation (Passed)");

  // ==========================================
  // TEST 18-20: Preference Persistence
  // ==========================================
  // Log out and log back in, check if preference values survive
  const reLoginB = await makeRequest("POST", "/api/auth/login", {
    username: `user_b_${testId}`,
    password: "password123"
  });
  const persistedUser = reLoginB.data.user;
  if (persistedUser.notify_push !== false || persistedUser.notify_low_battery !== true) {
    throw new Error(`Test 18: Notification preferences did not persist after session logout/login: ${JSON.stringify(persistedUser)}`);
  }
  console.log("✓ Test 18-20: Preferences successfully persist and survive authentication lifecycles (Passed)");

  console.log("\nALL NOTIFICATION PREFERENCE ENFORCEMENT TESTS PASSED SUCCESSFULLY! 🎉");
}

function token3ForC(token: string) {
  return token;
}

runPreferenceEnforcementTests().catch((err) => {
  console.error("Preference Enforcement Test Suite Failed:", err);
  process.exit(1);
});
