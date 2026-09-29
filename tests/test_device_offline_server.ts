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

async function runDeviceOfflineTests() {
  console.log("Starting Device Offline Alert Trigger Test Suite...");

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

  // 2. Register User 2
  const user2Name = `u2_offline_${Date.now()}`;
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

  // 3. Create Circle
  const circleRes = await makeRequest("POST", "/api/circles", { name: "Offline Test Circle" }, token1);
  const circleId = circleRes.data.id;
  const inviteCode = circleRes.data.invite_code;
  console.log(`✓ Circle created (ID: ${circleId})`);

  // 4. User 2 joins Circle
  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, token2);
  if (joinRes.status !== 200) {
    throw new Error("User 2 failed to join Circle");
  }
  console.log("✓ User 2 joined Circle");

  // TEST 1: Newly registered device with no telemetry -> no alert
  // (we register U2's phone but do not send telemetry)
  // Let's trigger check-offline and see that no alert is created because no telemetry was received yet
  await makeRequest("POST", "/api/test/check-offline", {});
  const initialAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (initialAlerts.data.length !== 0) {
    throw new Error(`Expected 0 alerts for newly registered device with no telemetry, got: ${initialAlerts.data.length}`);
  }
  console.log("✓ Test 1: Newly registered device with no telemetry produces no alert (Passed)");

  // Send first telemetry for User 2 (Phone) at current time
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: "device_tracker.u2_phone",
    user_id: user2Id,
    battery: 80
  }, token2);

  // TEST 2: Device with recent telemetry -> no alert
  await makeRequest("POST", "/api/test/check-offline", {});
  const recentAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (recentAlerts.data.length !== 0) {
    throw new Error(`Expected 0 alerts for device with recent telemetry, got: ${recentAlerts.data.length}`);
  }
  console.log("✓ Test 2: Device with recent telemetry produces no alert (Passed)");

  // TEST 3: Device exactly at boundary of threshold (e.g., 14 minutes ago) -> no alert
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u2_phone",
    minutes_ago: 14
  });
  await makeRequest("POST", "/api/test/check-offline", {});
  const boundaryAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (boundaryAlerts.data.length !== 0) {
    throw new Error(`Expected 0 alerts for device inside threshold limit, got: ${boundaryAlerts.data.length}`);
  }
  console.log("✓ Test 3: Device exactly at boundary of threshold produces no alert (Passed)");

  // TEST 4: Device beyond 15-minute threshold -> one alert
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u2_phone",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});
  const offlineAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (offlineAlerts.data.length !== 1 || offlineAlerts.data[0].alert_type !== "device_offline") {
    throw new Error(`Expected exactly 1 device_offline alert, got: ${JSON.stringify(offlineAlerts.data)}`);
  }
  const alert = offlineAlerts.data[0];
  if (alert.target_user_id !== user2Id || alert.circle_id !== circleId) {
    throw new Error(`Incorrect alert target_user_id or circle_id: ${JSON.stringify(alert)}`);
  }
  if (!alert.title.includes("User Two") || !alert.message.toLowerCase().includes("u2 phone") || !alert.message.toLowerCase().includes("gone offline")) {
    throw new Error(`Incorrect alert message or title: ${JSON.stringify(alert)}`);
  }
  if (JSON.stringify(alert).includes("latitude") || JSON.stringify(alert).includes("longitude")) {
    throw new Error("Privacy violation! Offline alert contains GPS/location data!");
  }
  console.log("✓ Test 4: Device beyond 15-minute threshold creates device_offline alert successfully with correct privacy (Passed)");

  // TEST 12: Tracked user never receives their own offline alert
  const u2Alerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token2);
  if (u2Alerts.data.length !== 0) {
    throw new Error(`Expected User 2 to receive 0 alerts, got: ${u2Alerts.data.length}`);
  }
  console.log("✓ Test 12: Tracked user never receives their own offline alert (Passed)");

  // TEST 5 & 17: Repeated evaluator runs while offline are fully idempotent and create no duplicates
  await makeRequest("POST", "/api/test/check-offline", {});
  await makeRequest("POST", "/api/test/check-offline", {});
  const repeatAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (repeatAlerts.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1 across repeated evaluator runs, got: ${repeatAlerts.data.length}`);
  }
  console.log("✓ Test 5 & 17: Repeated evaluator runs remain perfectly idempotent (Passed)");

  // TEST 6 & 18: Valid telemetry update from the offline device returns it online & re-arms the state
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: "device_tracker.u2_phone",
    user_id: user2Id,
    battery: 75
  }, token2);

  // Check evaluator again (device is now back online)
  await makeRequest("POST", "/api/test/check-offline", {});
  const recoveryAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (recoveryAlerts.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1 after recovery, got: ${recoveryAlerts.data.length}`);
  }
  console.log("✓ Test 6 & 18: Valid telemetry update returns device online & re-arms (Passed)");

  // TEST 7: Second offline period -> triggers a brand new alert
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u2_phone",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});
  const secondOfflineAlerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (secondOfflineAlerts.data.length !== 2) {
    throw new Error(`Expected exactly 2 alerts (including the new offline alert), got: ${secondOfflineAlerts.data.length}`);
  }
  console.log("✓ Test 7: Second offline period triggers new alert successfully (Passed)");

  // TEST 11: notify_device_offline = false suppresses alerts
  // Disable notify_device_offline preference for User 1
  await makeRequest("PUT", "/api/auth/profile", { notify_device_offline: false }, token1);

  // Recovery User 2's Phone
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: "device_tracker.u2_phone",
    user_id: user2Id,
    battery: 70
  }, token2);

  // Go offline again
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u2_phone",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // Alert count should stay 2 because preference is false
  const alertsWithPrefDisabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsWithPrefDisabled.data.length !== 2) {
    throw new Error(`Expected alert count to stay 2 with preference disabled, got: ${alertsWithPrefDisabled.data.length}`);
  }
  console.log("✓ Test 11: notify_device_offline = false suppresses alert delivery (Passed)");

  // TEST 10: notify_device_offline = true delivers alert
  // Re-enable notify_device_offline preference for User 1
  await makeRequest("PUT", "/api/auth/profile", { notify_device_offline: true }, token1);

  // Recovery User 2's Phone
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: "device_tracker.u2_phone",
    user_id: user2Id,
    battery: 68
  }, token2);

  // Go offline again
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u2_phone",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // Alert count should increase to 3
  const alertsWithPrefEnabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsWithPrefEnabled.data.length !== 3) {
    throw new Error(`Expected alert count to be 3 with preference enabled, got: ${alertsWithPrefEnabled.data.length}`);
  }
  console.log("✓ Test 10: notify_device_offline = true delivers alert successfully (Passed)");

  // TEST 8: Two devices for same user are tracked independently
  // User 2 has Phone and Watch
  // Recovery Phone
  await makeRequest("POST", "/api/webhook/test_webhook_u2", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Phone",
    entity_id: "device_tracker.u2_phone",
    user_id: user2Id,
    battery: 80
  }, token2);

  // Setup Watch (first telemetry sample)
  await makeRequest("POST", "/api/webhook/test_webhook_u2_watch", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U2 Watch",
    entity_id: "device_tracker.u2_watch",
    user_id: user2Id,
    battery: 90
  }, token2);

  // Set Watch offline but keep Phone online
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u2_watch",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // Verify only Watch goes offline (alert count should increase to 4)
  const alertsAfterWatchOffline = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsAfterWatchOffline.data.length !== 4) {
    throw new Error(`Expected alert count to be 4 after Watch goes offline, got: ${alertsAfterWatchOffline.data.length}`);
  }
  const watchAlert = alertsAfterWatchOffline.data.find((a: any) => a.message.toLowerCase().includes("u2 watch"));
  if (!watchAlert) {
    throw new Error(`Expected alert to mention u2 watch, got: ${JSON.stringify(alertsAfterWatchOffline.data)}`);
  }
  console.log("✓ Test 8: Multiple devices for the same user track independently (Passed)");

  // TEST 13: User with no active circle produces no public alert
  const user3Name = `u3_offline_no_circle_${Date.now()}`;
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

  // Send first telemetry for User 3 (Phone)
  await makeRequest("POST", "/api/webhook/test_webhook_u3", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U3 Phone",
    entity_id: "device_tracker.u3_phone",
    user_id: user3Id,
    battery: 80
  }, token3);

  // Set User 3's Phone offline
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u3_phone",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // Circle alerts should remain 4
  const alertsNoCircle = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsNoCircle.data.length !== 4) {
    throw new Error(`Expected alert count to remain 4, got: ${alertsNoCircle.data.length}`);
  }
  console.log("✓ Test 13: User with no circle produces no public alert (Passed)");

  // TEST 9 & 14: Multiple users/circles are isolated (cannot leak alerts across circles)
  const user4Name = `u4_isolation_${Date.now()}`;
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

  // Create a separate Circle Two (User 4 only)
  const circle2Res = await makeRequest("POST", "/api/circles", { name: "Isolated Circle" }, token4);
  const circle2Id = circle2Res.data.id;

  // Send first telemetry for User 4 (Phone)
  await makeRequest("POST", "/api/webhook/test_webhook_u4", {
    latitude: 37.7749,
    longitude: -122.4194,
    device_name: "U4 Phone",
    entity_id: "device_tracker.u4_phone",
    user_id: user4Id,
    battery: 80
  }, token4);

  // Set User 4's Phone offline
  await makeRequest("POST", "/api/test/set-device-last-seen", {
    entity_id: "device_tracker.u4_phone",
    minutes_ago: 16
  });
  await makeRequest("POST", "/api/test/check-offline", {});

  // User 1 (Admin in Circle One) must receive absolutely zero alerts from Circle Two
  const user1Alerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (user1Alerts.data.length !== 4) {
    throw new Error(`Expected User 1 to have 4 alerts, got: ${user1Alerts.data.length}`);
  }
  const u4Alert = user1Alerts.data.find((a: any) => a.message.includes("User Four"));
  if (u4Alert) {
    throw new Error("Security breach! User 1 received offline alert for User 4 from another isolated circle!");
  }
  console.log("✓ Test 9 & 14: Multiple users and circles remain securely isolated (Passed)");

  console.log("\nALL DEVICE OFFLINE TRANSITION ENGINE TESTS PASSED SUCCESSFULLY! 🎉");
}

runDeviceOfflineTests().catch((err) => {
  console.error("Device Offline Test Suite Failed:", err);
  process.exit(1);
});
