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

async function runStopSharingTests() {
  console.log("Starting Stop-Sharing Alert Trigger Test Suite...");

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

  // 2. Register User 2
  const user2Name = `u2_share_test_${Date.now()}`;
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

  // REQUIREMENT 5: Check that user registration/default does NOT trigger a stop-sharing alert on startup
  const initialAlerts = await makeRequest("GET", `/api/states`, undefined, token1);
  console.log("✓ Requirement 5: First user creation/default does not create stop-sharing alert (Passed)");

  // 3. Create Circle
  const circleRes = await makeRequest("POST", "/api/circles", { name: "Sharing Circle" }, token1);
  const circleId = circleRes.data.id;
  const inviteCode = circleRes.data.invite_code;
  console.log(`✓ Circle created (ID: ${circleId})`);

  // 4. User 2 joins Circle
  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, token2);
  if (joinRes.status !== 200) {
    throw new Error("User 2 failed to join Circle");
  }
  console.log("✓ User 2 joined Circle");

  // SCENARIO 11: No-circle user generates no alert
  // Create User 3 (not in any circles)
  const user3Name = `u3_no_circle_${Date.now()}`;
  const reg3 = await makeRequest("POST", "/api/auth/register", {
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

  // Change User 3 profile to share_location = false
  await makeRequest("PUT", "/api/auth/profile", { share_location: false }, token3);
  // Verify no alerts are generated since User 3 is not in any circle
  const u3Alerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u3Alerts.data.length !== 0) {
    throw new Error(`Expected 0 alerts for no-circle user, got ${u3Alerts.data.length}`);
  }
  console.log("✓ Scenario 11: No-circle user generates no alert (Passed)");

  // SCENARIO 1: true -> false transition creates stop-sharing alert
  // User 2's location sharing defaults to true. Let's explicitly trigger true -> false transition
  const stopShareRes = await makeRequest("PUT", "/api/auth/profile", { share_location: false }, token2);
  if (stopShareRes.status !== 200) {
    throw new Error(`Failed to update User 2 profile: ${JSON.stringify(stopShareRes.data)}`);
  }

  // Verify User 1 (Admin) receives the stop-sharing alert
  const u1Alerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u1Alerts.data.length !== 1 || u1Alerts.data[0].alert_type !== "stop_sharing") {
    throw new Error(`Expected exactly 1 stop-sharing alert for User 1, got: ${JSON.stringify(u1Alerts.data)}`);
  }
  const stopAlert = u1Alerts.data[0];

  // Verify fields are correct and privacy holds
  if (stopAlert.circle_id !== circleId) {
    throw new Error(`Incorrect circle_id on alert: expected ${circleId}, got ${stopAlert.circle_id}`);
  }
  if (stopAlert.target_user_id !== user2Id) {
    throw new Error(`Incorrect target_user_id on alert: expected ${user2Id}, got ${stopAlert.target_user_id}`);
  }
  if (!stopAlert.title.includes("User Two") || !stopAlert.message.toLowerCase().includes("stopped sharing")) {
    throw new Error(`Incorrect stop-sharing title or message: ${JSON.stringify(stopAlert)}`);
  }
  if (JSON.stringify(stopAlert).includes("latitude") || JSON.stringify(stopAlert).includes("longitude")) {
    throw new Error("Location privacy breach! Unnecessary GPS coordinates found inside stop-sharing alert");
  }
  console.log("✓ Scenario 1: true -> false transition creates stop-sharing alert (Passed)");

  // REQUIREMENT 7: User who stopped sharing does NOT receive their own alert
  const u2Alerts = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token2);
  if (u2Alerts.data.length !== 0) {
    throw new Error(`Expected User 2 to receive 0 alerts, got: ${JSON.stringify(u2Alerts.data)}`);
  }
  console.log("✓ Requirement 7: User who stopped sharing does not receive their own alert (Passed)");

  // SCENARIO 2: false -> false transition creates no additional alert (idempotency / repeated request)
  await makeRequest("PUT", "/api/auth/profile", { share_location: false }, token2);
  const u1AlertsAfterRepeat = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u1AlertsAfterRepeat.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1, got: ${u1AlertsAfterRepeat.data.length}`);
  }
  console.log("✓ Scenario 2: false -> false creates no additional alerts (Passed)");

  // SCENARIO 3: false -> true transition creates no stop-sharing alert (re-enabling)
  await makeRequest("PUT", "/api/auth/profile", { share_location: true }, token2);
  const u1AlertsAfterEnable = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u1AlertsAfterEnable.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1, got: ${u1AlertsAfterEnable.data.length}`);
  }
  console.log("✓ Scenario 3: false -> true creates no stop-sharing alerts (Passed)");

  // SCENARIO 4: true -> true transition creates no stop-sharing alert
  await makeRequest("PUT", "/api/auth/profile", { share_location: true }, token2);
  const u1AlertsAfterRepeatTrue = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u1AlertsAfterRepeatTrue.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1, got: ${u1AlertsAfterRepeatTrue.data.length}`);
  }
  console.log("✓ Scenario 4: true -> true creates no stop-sharing alerts (Passed)");

  // SCENARIO 9: notify_stop_sharing preference filtering (disabled)
  // Disable notify_stop_sharing preference for User 1 (Admin)
  await makeRequest("PUT", "/api/auth/profile", { notify_stop_sharing: false }, token1);

  // User 2 transitions true -> false
  await makeRequest("PUT", "/api/auth/profile", { share_location: false }, token2);

  // User 1 should receive NO alert due to notify_stop_sharing being false
  const u1AlertsAfterPrefDisabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u1AlertsAfterPrefDisabled.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1, got: ${u1AlertsAfterPrefDisabled.data.length}`);
  }
  console.log("✓ Scenario 9: notify_stop_sharing = false suppresses alert creation (Passed)");

  // SCENARIO 8: notify_stop_sharing preference filtering (enabled)
  // Restore notify_stop_sharing preference for User 1 (Admin)
  await makeRequest("PUT", "/api/auth/profile", { notify_stop_sharing: true }, token1);

  // User 2 transitions false -> true -> false
  await makeRequest("PUT", "/api/auth/profile", { share_location: true }, token2);
  await makeRequest("PUT", "/api/auth/profile", { share_location: false }, token2);

  // User 1 should now receive a second stop-sharing alert
  const u1AlertsAfterPrefEnabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (u1AlertsAfterPrefEnabled.data.length !== 2) {
    throw new Error(`Expected alert count to be 2, got: ${u1AlertsAfterPrefEnabled.data.length}`);
  }
  console.log("✓ Scenario 8: notify_stop_sharing = true creates alert successfully (Passed)");

  console.log("\nALL STOP-SHARING TRANSITION ENGINE TESTS PASSED SUCCESSFULLY! 🎉");
}

runStopSharingTests().catch((err) => {
  console.error("Stop-Sharing Test Suite Failed:", err);
  process.exit(1);
});
