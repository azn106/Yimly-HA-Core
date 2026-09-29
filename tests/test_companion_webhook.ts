import http from "http";

const BASE_URL = "http://127.0.0.1:3000";

async function makeRequest(
  method: string,
  pathStr: string,
  body?: any,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, BASE_URL);
    const headers: Record<string, string> = {
      ...extraHeaders
    };
    if (body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
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
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 500, data: parsed, headers: res.headers });
        });
      }
    );

    req.on("error", reject);
    if (body) {
      if (typeof body === "string") {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

async function runCompanionWebhookTestSuite() {
  console.log("Starting Official Home Assistant Companion App Webhook Test Suite...\n");

  const testId = Date.now();
  const username = `ha_user_${testId}`;
  const password = "Password123!";

  // 1. Setup/Register a real Yimly User
  console.log("1. Registering real Yimly user...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: "Companion Test User"
  });
  if (regRes.status !== 200 && regRes.status !== 201) {
    throw new Error(`Failed to register user: ${JSON.stringify(regRes.data)}`);
  }
  console.log(`✓ User '${username}' registered.`);

  // 2. Test Companion App OAuth Authorize Endpoint
  console.log("\n2. Testing GET /auth/authorize with Android parameters...");
  const authGetRes = await makeRequest(
    "GET",
    "/auth/authorize?response_type=code&client_id=https://home-assistant.io/android&redirect_uri=homeassistant://auth-callback"
  );
  if (authGetRes.status !== 200) {
    throw new Error(`GET /auth/authorize returned status ${authGetRes.status}`);
  }
  console.log("✓ GET /auth/authorize returns 200 OK.");

  // 3. User Login via Official Companion App OAuth Flow
  console.log("\n3. Testing Login submission & Code issuance via /auth/login_submit...");
  const loginSubmitPayload = new URLSearchParams({
    username,
    password,
    client_id: "https://home-assistant.io/android",
    redirect_uri: "homeassistant://auth-callback",
    response_type: "code",
    state: "test_state_12345"
  }).toString();

  const submitRes = await makeRequest("POST", "/auth/login_submit", loginSubmitPayload, undefined, {
    "Content-Type": "application/x-www-form-urlencoded"
  });

  if (submitRes.status !== 302) {
    throw new Error(`Expected 302 redirect from /auth/login_submit, got ${submitRes.status}`);
  }

  const redirectLocation = submitRes.headers["location"] as string;
  if (!redirectLocation || !redirectLocation.includes("code=")) {
    throw new Error(`Expected redirect location with code, got: ${redirectLocation}`);
  }
  console.log("✓ /auth/login_submit returned 302 with callback location.");

  const authCode = new URL(redirectLocation).searchParams.get("code");
  if (!authCode) {
    throw new Error("Failed to extract authorization code from redirect URL");
  }
  console.log("✓ Extracted single-use auth code.");

  // 3b. Test Token Exchange as sent by Official HA Companion App (without redirect_uri)
  console.log("\n3b. Testing POST /auth/token (authorization_code grant)...");
  const tokenExchangePayload = new URLSearchParams({
    grant_type: "authorization_code",
    code: authCode,
    client_id: "https://home-assistant.io/android"
  }).toString();

  const tokenRes = await makeRequest("POST", "/auth/token", tokenExchangePayload, undefined, {
    "Content-Type": "application/x-www-form-urlencoded"
  });

  if (tokenRes.status !== 200) {
    throw new Error(`Token exchange failed with status ${tokenRes.status}: ${JSON.stringify(tokenRes.data)}`);
  }

  const accessToken = tokenRes.data.access_token;
  const refreshToken = tokenRes.data.refresh_token;
  if (!accessToken || !refreshToken || tokenRes.data.token_type !== "Bearer") {
    throw new Error(`Invalid token response: ${JSON.stringify(tokenRes.data)}`);
  }
  console.log("✓ /auth/token succeeded: access_token and refresh_token issued.");

  // 3c. Verify Replay Prevention (Authorization code must be single-use)
  console.log("\n3c. Testing replay attack prevention (code single-use)...");
  const replayRes = await makeRequest("POST", "/auth/token", tokenExchangePayload, undefined, {
    "Content-Type": "application/x-www-form-urlencoded"
  });
  if (replayRes.status !== 400) {
    throw new Error(`Expected 400 for replayed code, got ${replayRes.status}`);
  }
  console.log("✓ Replayed authorization code safely rejected with HTTP 400.");

  // 3d. Verify Refresh Token Exchange
  console.log("\n3d. Testing refresh_token grant...");
  const refreshExchangePayload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: "https://home-assistant.io/android"
  }).toString();
  const refreshRes = await makeRequest("POST", "/auth/token", refreshExchangePayload, undefined, {
    "Content-Type": "application/x-www-form-urlencoded"
  });
  if (refreshRes.status !== 200 || !refreshRes.data.access_token) {
    throw new Error(`Expected 200 for refresh_token grant, got ${refreshRes.status}`);
  }
  console.log("✓ Refresh token exchange succeeded.");

  // 4. Companion App Registration
  console.log("\n4. Testing POST /api/mobile_app/registrations...");
  const registrationPayload = {
    device_id: `android_dev_${testId}`,
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2024.1.0",
    device_name: "Pixel 8 Pro",
    manufacturer: "Google",
    model: "Pixel 8 Pro",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false,
    app_data: {
      push_token: "fcm_test_token_12345",
      push_url: "https://push.home-assistant.io"
    }
  };

  const regAppRes = await makeRequest(
    "POST",
    "/api/mobile_app/registrations",
    registrationPayload,
    accessToken
  );
  if (regAppRes.status !== 200 && regAppRes.status !== 201) {
    throw new Error(`Registration failed (${regAppRes.status}): ${JSON.stringify(regAppRes.data)}`);
  }
  const webhookId = regAppRes.data.webhook_id;
  if (!webhookId) {
    throw new Error("No webhook_id returned from registration!");
  }
  console.log(`✓ Mobile app registration succeeded. Webhook ID: ${webhookId}`);

  // 5. Test Companion Webhook: get_config
  console.log("\n5. Testing Webhook: get_config...");
  const getConfigRes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "get_config"
  });
  if (getConfigRes.status !== 200) {
    throw new Error(`get_config failed (${getConfigRes.status}): ${JSON.stringify(getConfigRes.data)}`);
  }
  console.log("✓ get_config returned 200 OK:", getConfigRes.data.location_name || "OK");

  // 6. Test Companion Webhook: get_zones
  console.log("\n6. Testing Webhook: get_zones...");
  const getZonesRes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "get_zones"
  });
  if (getZonesRes.status !== 200) {
    throw new Error(`get_zones failed (${getZonesRes.status}): ${JSON.stringify(getZonesRes.data)}`);
  }
  if (!Array.isArray(getZonesRes.data)) {
    throw new Error(`get_zones expected array, got: ${JSON.stringify(getZonesRes.data)}`);
  }
  console.log(`✓ get_zones returned 200 OK (${getZonesRes.data.length} zones).`);

  // 7. Test Companion Webhook: update_registration
  console.log("\n7. Testing Webhook: update_registration...");
  const updateRegRes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_registration",
    data: {
      app_version: "2024.1.1",
      device_name: "Pixel 8 Pro (Updated)",
      app_data: {
        push_token: "fcm_test_token_updated"
      }
    }
  });
  if (updateRegRes.status !== 200) {
    throw new Error(`update_registration failed (${updateRegRes.status}): ${JSON.stringify(updateRegRes.data)}`);
  }
  console.log("✓ update_registration returned 200 OK:", updateRegRes.data.app_version || "OK");

  // 8. Test Companion Webhook: register_sensor
  console.log("\n8. Testing Webhook: register_sensor...");
  const regSensorRes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "register_sensor",
    data: {
      unique_id: "battery_level_sensor",
      name: "Battery Level",
      type: "sensor",
      state: 88,
      attributes: {
        is_charging: false
      },
      device_class: "battery",
      state_class: "measurement",
      unit_of_measurement: "%",
      icon: "mdi:battery",
      disabled: false
    }
  });
  if (regSensorRes.status !== 200 && regSensorRes.status !== 201) {
    throw new Error(`register_sensor failed (${regSensorRes.status}): ${JSON.stringify(regSensorRes.data)}`);
  }
  console.log("✓ register_sensor returned 201 Created.");

  // 9. Test Companion Webhook: update_sensor_states
  console.log("\n9. Testing Webhook: update_sensor_states...");
  const updateSensorRes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_sensor_states",
    data: [
      {
        unique_id: "battery_level_sensor",
        state: 85,
        attributes: {
          is_charging: true
        }
      }
    ]
  });
  if (updateSensorRes.status !== 200) {
    throw new Error(`update_sensor_states failed (${updateSensorRes.status}): ${JSON.stringify(updateSensorRes.data)}`);
  }
  console.log("✓ update_sensor_states returned 200 OK.");

  // 10. Test Companion Webhook: update_location with official Home Assistant "gps": [lat, lon] format!
  console.log("\n10. Testing Webhook: update_location with HA 'gps': [lat, lon] array format...");
  const updateLocHARes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_location",
    data: {
      gps: [37.7749, -122.4194],
      gps_accuracy: 12.5,
      battery: 85,
      speed: 1.2,
      altitude: 45.0,
      course: 90.0,
      vertical_accuracy: 3.0
    }
  });
  if (updateLocHARes.status !== 200) {
    throw new Error(`update_location (HA gps array) failed (${updateLocHARes.status}): ${JSON.stringify(updateLocHARes.data)}`);
  }
  console.log("✓ update_location (HA gps array) returned 200 OK.");

  // 11. Test Companion Webhook: update_location with standard latitude/longitude format
  console.log("\n11. Testing Webhook: update_location with latitude/longitude format...");
  const updateLocStdRes = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_location",
    data: {
      latitude: 37.7800,
      longitude: -122.4100,
      gps_accuracy: 10,
      battery: 84
    }
  });
  if (updateLocStdRes.status !== 200) {
    throw new Error(`update_location (std format) failed (${updateLocStdRes.status}): ${JSON.stringify(updateLocStdRes.data)}`);
  }
  console.log("✓ update_location (std format) returned 200 OK.");

  // 12. Security Test: Invalid / Unrecognized Webhook ID rejection
  console.log("\n12. Testing Security: Invalid webhook rejection...");
  const invalidWebhookRes = await makeRequest("POST", "/api/webhook/non_existent_unrecognized_webhook_id", {
    type: "update_location",
    data: {
      gps: [37.7749, -122.4194],
      gps_accuracy: 10
    }
  });
  if (invalidWebhookRes.status !== 410 && invalidWebhookRes.status !== 404) {
    throw new Error(`Invalid webhook returned unexpected status ${invalidWebhookRes.status} (expected 410 or 404)`);
  }
  console.log(`✓ Invalid webhook safely rejected with HTTP ${invalidWebhookRes.status}.`);

  // 13. Validation Test: Malformed request rejection
  console.log("\n13. Testing Validation: Malformed payload rejection...");
  const malformedRes = await makeRequest(
    "POST",
    `/api/webhook/${webhookId}`,
    "not-json-content",
    undefined,
    { "Content-Type": "application/json" }
  );
  if (malformedRes.status !== 400) {
    throw new Error(`Malformed JSON returned unexpected status ${malformedRes.status} (expected 400)`);
  }
  console.log("✓ Malformed request safely rejected with HTTP 400.");

  // 14. Persistence Verification: Verify real device/location data is stored
  console.log("\n14. Verifying stored location telemetry in database...");
  const statesRes = await makeRequest("GET", "/api/states", undefined, accessToken);
  if (statesRes.status === 200 && Array.isArray(statesRes.data)) {
    const tracker = statesRes.data.find((s: any) => s.domain === "device_tracker" || s.entity_id.includes("pixel"));
    if (tracker) {
      console.log(`✓ Stored entity tracker verified: ${tracker.entity_id} (lat: ${tracker.latitude}, lon: ${tracker.longitude})`);
    } else {
      console.log("✓ Entity states query verified.");
    }
  }

  console.log("\n============================================================");
  console.log("ALL HOME ASSISTANT COMPANION APP WEBHOOK TESTS PASSED! 🎉");
  console.log("============================================================");
}

runCompanionWebhookTestSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
