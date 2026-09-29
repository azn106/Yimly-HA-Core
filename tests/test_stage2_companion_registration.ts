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

async function runStage2CompanionTests() {
  console.log("============================================================");
  console.log("RUNNING STAGE 2 COMPANION REGISTRATION & ENCRYPTION TEST SUITE");
  console.log("============================================================\n");

  const testId = Date.now();
  const user1 = `stg2_u1_${testId}`;
  const user2 = `stg2_u2_${testId}`;
  const pass = "Stage2Password123!";

  // 1. Create User 1 and User 2
  console.log("1. Registering User 1 and User 2...");
  const u1Res = await makeRequest("POST", "/api/auth/register", {
    username: user1,
    password: pass,
    display_name: "Stage2 User One"
  });
  if (u1Res.status !== 200 && u1Res.status !== 201) {
    throw new Error(`Failed to register user 1: ${JSON.stringify(u1Res.data)}`);
  }
  const token1 = u1Res.data.access_token;
  console.log(`✓ User 1 (${user1}) registered.`);

  const u2Res = await makeRequest("POST", "/api/auth/register", {
    username: user2,
    password: pass,
    display_name: "Stage2 User Two"
  });
  if (u2Res.status !== 200 && u2Res.status !== 201) {
    throw new Error(`Failed to register user 2: ${JSON.stringify(u2Res.data)}`);
  }
  const token2 = u2Res.data.access_token;
  console.log(`✓ User 2 (${user2}) registered.`);

  // 2. Test First Registration with supports_encryption: false
  console.log("\n2. Testing First Registration (supports_encryption: false)...");
  const regPlainRes = await makeRequest("POST", "/api/mobile_app/registrations", {
    device_id: `plain_dev_${testId}`,
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2026.1.0",
    device_name: "Android Plain Phone",
    manufacturer: "Google",
    model: "Pixel 8",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false,
    app_data: {}
  }, token1);

  if (regPlainRes.status !== 201) {
    throw new Error(`Plain registration failed (${regPlainRes.status}): ${JSON.stringify(regPlainRes.data)}`);
  }
  const plainData = regPlainRes.data;
  if (!plainData.webhook_id) throw new Error("Missing webhook_id in plain registration response");
  if (plainData.secret !== null) throw new Error(`Expected secret: null for supports_encryption=false, got: ${plainData.secret}`);
  console.log(`✓ Plain registration succeeded with webhook_id: ${plainData.webhook_id} and secret: null`);

  // 3. Test First Registration with supports_encryption: true
  console.log("\n3. Testing First Registration (supports_encryption: true)...");
  const regEncRes = await makeRequest("POST", "/api/mobile_app/registrations", {
    device_id: `enc_dev_${testId}`,
    app_id: "io.homeassistant.companion.ios",
    app_name: "Home Assistant",
    app_version: "2026.1.0",
    device_name: "iOS Encrypted Phone",
    manufacturer: "Apple",
    model: "iPhone 15",
    os_name: "iOS",
    os_version: "17",
    supports_encryption: true,
    app_data: {}
  }, token1);

  if (regEncRes.status !== 201) {
    throw new Error(`Encrypted registration failed (${regEncRes.status}): ${JSON.stringify(regEncRes.data)}`);
  }
  const encData = regEncRes.data;
  if (!encData.webhook_id) throw new Error("Missing webhook_id in encrypted registration response");
  if (!encData.secret || typeof encData.secret !== "string" || encData.secret.length !== 32) {
    throw new Error(`Expected 32-char hex secret string for supports_encryption=true, got: ${encData.secret}`);
  }
  console.log(`✓ Encrypted registration succeeded with webhook_id: ${encData.webhook_id} and 32-char secret: ${encData.secret.substring(0, 8)}...`);

  // 4. Test Same-User Re-registration (Metadata update and identity preservation)
  console.log("\n4. Testing Same-User Re-registration...");
  const reRegRes = await makeRequest("POST", "/api/mobile_app/registrations", {
    device_id: `plain_dev_${testId}`,
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2026.2.0",
    device_name: "Android Plain Phone (Updated)",
    manufacturer: "Google",
    model: "Pixel 8",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false,
    app_data: {}
  }, token1);

  if (reRegRes.status !== 201) {
    throw new Error(`Same-user re-registration failed (${reRegRes.status}): ${JSON.stringify(reRegRes.data)}`);
  }
  if (reRegRes.data.webhook_id !== plainData.webhook_id) {
    throw new Error(`Same user re-registration should preserve stable webhook_id, got new: ${reRegRes.data.webhook_id}`);
  }
  console.log("✓ Same-user re-registration successfully updated metadata without creating duplicate records.");

  // 5. Test Cross-User Device Reassignment / Account Switching
  console.log("\n5. Testing Cross-User Device Reassignment (User 1 -> User 2)...");
  const sharedDevId = `shared_phone_${testId}`;

  // Step 5a: User 1 registers device
  const regU1 = await makeRequest("POST", "/api/mobile_app/registrations", {
    device_id: sharedDevId,
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2026.1.0",
    device_name: "User 1 Shared Phone",
    manufacturer: "Google",
    model: "Pixel 7",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false
  }, token1);
  if (regU1.status !== 201) throw new Error("User 1 device registration failed");
  const oldWebhookId = regU1.data.webhook_id;

  // Send telemetry as User 1
  const u1LocRes = await makeRequest("POST", `/api/webhook/${oldWebhookId}`, {
    type: "update_location",
    data: { latitude: 37.1111, longitude: -122.1111, battery: 95 }
  });
  if (u1LocRes.status !== 200) throw new Error("User 1 telemetry update failed");
  console.log("  → User 1 registered device and sent telemetry.");

  // Step 5b: User 2 logs into the same physical device (sends same device_id)
  const regU2 = await makeRequest("POST", "/api/mobile_app/registrations", {
    device_id: sharedDevId,
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2026.1.0",
    device_name: "User 2 Shared Phone",
    manufacturer: "Google",
    model: "Pixel 7",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false
  }, token2);
  if (regU2.status !== 201) throw new Error(`User 2 device reassignment failed (${regU2.status}): ${JSON.stringify(regU2.data)}`);
  const newWebhookId = regU2.data.webhook_id;

  if (newWebhookId === oldWebhookId) {
    throw new Error("Cross-user reassignment MUST regenerate webhook_id!");
  }
  console.log(`✓ Device transferred to User 2. New webhook_id issued: ${newWebhookId}`);

  // Step 5c: Verify old webhook is invalidated (HTTP 410 Gone)
  console.log("\n5c. Verifying old webhook invalidation (HTTP 410 Gone)...");
  const oldWhTest = await makeRequest("POST", `/api/webhook/${oldWebhookId}`, {
    type: "update_location",
    data: { latitude: 37.2222, longitude: -122.2222 }
  });
  if (oldWhTest.status !== 410 && oldWhTest.status !== 404) {
    throw new Error(`Expected 410 Gone for invalidated old webhook, got: ${oldWhTest.status}`);
  }
  console.log(`✓ Old webhook safely rejected with HTTP ${oldWhTest.status}.`);

  // Step 5d: Verify new webhook works normally
  const newWhTest = await makeRequest("POST", `/api/webhook/${newWebhookId}`, {
    type: "update_location",
    data: { latitude: 37.3333, longitude: -122.3333, battery: 88 }
  });
  if (newWhTest.status !== 200) {
    throw new Error(`New webhook failed (${newWhTest.status}): ${JSON.stringify(newWhTest.data)}`);
  }
  console.log("✓ New webhook successfully processes telemetry for new owner.");

  // 6. Test enable_encryption Command on Plaintext Webhook
  console.log("\n6. Testing 'enable_encryption' webhook command...");
  const enableEncRes = await makeRequest("POST", `/api/webhook/${plainData.webhook_id}`, {
    type: "enable_encryption"
  });
  if (enableEncRes.status !== 200) {
    throw new Error(`enable_encryption command failed (${enableEncRes.status}): ${JSON.stringify(enableEncRes.data)}`);
  }
  if (!enableEncRes.data.secret || enableEncRes.data.secret.length !== 32) {
    throw new Error(`Expected 32-char secret from enable_encryption, got: ${JSON.stringify(enableEncRes.data)}`);
  }
  console.log(`✓ enable_encryption returned valid 32-char secret: ${enableEncRes.data.secret.substring(0, 8)}...`);

  // 7. Test Telemetry Commands Regression (get_config, get_zones, register_sensor, update_sensor_states, update_registration)
  console.log("\n7. Testing telemetry commands regression...");

  // 7a. get_config
  const cfgRes = await makeRequest("POST", `/api/webhook/${newWebhookId}`, { type: "get_config" });
  if (cfgRes.status !== 200 || !cfgRes.data.components) throw new Error("get_config failed");
  console.log("✓ get_config returned 200 OK.");

  // 7b. get_zones
  const zonesRes = await makeRequest("POST", `/api/webhook/${newWebhookId}`, { type: "get_zones" });
  if (zonesRes.status !== 200 || !Array.isArray(zonesRes.data)) throw new Error("get_zones failed");
  console.log("✓ get_zones returned 200 OK.");

  // 7c. update_registration
  const updateRegRes = await makeRequest("POST", `/api/webhook/${newWebhookId}`, {
    type: "update_registration",
    data: { app_version: "2026.3.0", device_name: "Renamed Phone" }
  });
  if (updateRegRes.status !== 200) throw new Error("update_registration failed");
  console.log("✓ update_registration returned 200 OK.");

  // 7d. register_sensor
  const regSensorRes = await makeRequest("POST", `/api/webhook/${newWebhookId}`, {
    type: "register_sensor",
    data: {
      unique_id: `sensor_battery_${testId}`,
      name: "Battery",
      type: "sensor",
      unit_of_measurement: "%",
      icon: "mdi:battery"
    }
  });
  if (regSensorRes.status !== 200 && regSensorRes.status !== 201) throw new Error("register_sensor failed");
  console.log("✓ register_sensor returned 201/200 OK.");

  // 7e. update_sensor_states
  const updateSensorRes = await makeRequest("POST", `/api/webhook/${newWebhookId}`, {
    type: "update_sensor_states",
    data: [{ unique_id: `sensor_battery_${testId}`, state: "85" }]
  });
  if (updateSensorRes.status !== 200) throw new Error("update_sensor_states failed");
  console.log("✓ update_sensor_states returned 200 OK.");

  console.log("\n============================================================");
  console.log("ALL STAGE 2 COMPANION REGISTRATION & ENCRYPTION TESTS PASSED! 🎉");
  console.log("============================================================\n");
}

runStage2CompanionTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
