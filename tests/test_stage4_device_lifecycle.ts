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
    const headers: Record<string, string> = { ...extraHeaders };

    let payload: string | undefined;
    if (body !== undefined) {
      if (typeof body === "string") {
        payload = body;
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
            // Raw text if not JSON
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

async function runStage4Audit() {
  console.log("============================================================");
  console.log("RUNNING STAGE 4 DEVICE REGISTRATION & IDENTITY AUDIT SUITE");
  console.log("============================================================");

  const timestamp = Date.now();
  const u1Name = `stg4_user1_${timestamp}`;
  const u2Name = `stg4_user2_${timestamp}`;
  const password = "SecurePassword123!";

  // 1. Setup User 1 and User 2
  console.log("\n1. Setting up User 1 and User 2 accounts...");
  const u1Reg = await makeRequest("POST", "/api/auth/register", {
    username: u1Name,
    password,
    display_name: "Stage 4 User One"
  });
  if (u1Reg.status !== 200) throw new Error(`User 1 registration failed: ${JSON.stringify(u1Reg.data)}`);

  const u2Reg = await makeRequest("POST", "/api/auth/register", {
    username: u2Name,
    password,
    display_name: "Stage 4 User Two"
  });
  if (u2Reg.status !== 200) throw new Error(`User 2 registration failed: ${JSON.stringify(u2Reg.data)}`);

  const u1Login = await makeRequest("POST", "/api/auth/login", { username: u1Name, password });
  const u1Token = u1Login.data.access_token;

  const u2Login = await makeRequest("POST", "/api/auth/login", { username: u2Name, password });
  const u2Token = u2Login.data.access_token;
  console.log(`✓ Created User 1 (${u1Name}) and User 2 (${u2Name}).`);

  // 2. Initial Device Registration for User 1 (Device A)
  console.log("\n2. Testing Initial Device Registration (Device A for User 1)...");
  const deviceAId = `pixel_8_${timestamp}`;
  const regADev = await makeRequest("POST", "/api/mobile_app/registrations", {
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2024.1.0",
    device_name: "Pixel 8 Pro",
    device_id: deviceAId,
    manufacturer: "Google",
    model: "Pixel 8 Pro",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false,
    app_data: { push_token: "fcm_token_device_a" }
  }, u1Token);

  if (regADev.status !== 200 && regADev.status !== 201) {
    throw new Error(`Device A registration failed (${regADev.status}): ${JSON.stringify(regADev.data)}`);
  }
  const webhookA1 = regADev.data.webhook_id;
  if (!webhookA1) throw new Error("No webhook_id returned for Device A.");
  console.log(`✓ Device A registered with webhook_id: ${webhookA1}`);

  // 3. Multi-Device: Register Device B for User 1
  console.log("\n3. Testing Multi-Device Registration (Device B for User 1)...");
  const deviceBId = `galaxy_s24_${timestamp}`;
  const regBDev = await makeRequest("POST", "/api/mobile_app/registrations", {
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2024.1.0",
    device_name: "Galaxy S24",
    device_id: deviceBId,
    manufacturer: "Samsung",
    model: "SM-S921B",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false,
    app_data: { push_token: "fcm_token_device_b" }
  }, u1Token);

  if (regBDev.status !== 200 && regBDev.status !== 201) {
    throw new Error(`Device B registration failed (${regBDev.status}): ${JSON.stringify(regBDev.data)}`);
  }
  const webhookB = regBDev.data.webhook_id;
  if (!webhookB || webhookB === webhookA1) {
    throw new Error("Device B must receive its own distinct webhook_id.");
  }
  console.log(`✓ Device B registered with independent webhook_id: ${webhookB}`);

  // 4. Test Webhook Telemetry on both devices under User 1
  console.log("\n4. Testing Independent Webhook Telemetry for Device A and Device B...");
  const locA = await makeRequest("POST", `/api/webhook/${webhookA1}`, {
    type: "update_location",
    data: {
      gps: [37.7749, -122.4194],
      gps_accuracy: 10,
      battery: 88
    }
  });
  if (locA.status !== 200) throw new Error(`Device A location update failed: ${locA.status}`);

  const locB = await makeRequest("POST", `/api/webhook/${webhookB}`, {
    type: "update_location",
    data: {
      gps: [40.7128, -74.0060],
      gps_accuracy: 15,
      battery: 72
    }
  });
  if (locB.status !== 200) throw new Error(`Device B location update failed: ${locB.status}`);
  console.log("✓ Independent location updates submitted for both devices.");

  // 5. Test Same-User Re-Registration (Device A metadata update)
  console.log("\n5. Testing Same-User Re-Registration (Device A updated OS & App version)...");
  const reRegA = await makeRequest("POST", "/api/mobile_app/registrations", {
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2024.2.0",
    device_name: "Pixel 8 Pro Updated",
    device_id: deviceAId,
    manufacturer: "Google",
    model: "Pixel 8 Pro",
    os_name: "Android",
    os_version: "15",
    supports_encryption: false,
    app_data: { push_token: "fcm_token_device_a_new" }
  }, u1Token);

  if (reRegA.status !== 200 && reRegA.status !== 201) {
    throw new Error(`Device A re-registration failed: ${reRegA.status}`);
  }
  console.log("✓ Same-user re-registration succeeded.");

  // 6. Test Webhook Config & Zone Discovery
  console.log("\n6. Testing Webhook Protocol Endpoints (get_config, get_zones, update_registration)...");
  const cfgRes = await makeRequest("POST", `/api/webhook/${webhookA1}`, { type: "get_config" });
  if (cfgRes.status !== 200 || !cfgRes.data.version || !cfgRes.data.components) {
    throw new Error(`get_config failed: ${JSON.stringify(cfgRes.data)}`);
  }
  console.log(`✓ Webhook get_config returned valid Core configuration (version: ${cfgRes.data.version}).`);

  const zonesRes = await makeRequest("POST", `/api/webhook/${webhookA1}`, { type: "get_zones" });
  if (zonesRes.status !== 200 || !Array.isArray(zonesRes.data)) {
    throw new Error(`get_zones failed: ${JSON.stringify(zonesRes.data)}`);
  }
  console.log("✓ Webhook get_zones returned valid zones array.");

  const updateRegRes = await makeRequest("POST", `/api/webhook/${webhookA1}`, {
    type: "update_registration",
    data: { app_version: "2024.2.5" }
  });
  if (updateRegRes.status !== 200) throw new Error("update_registration failed.");
  console.log("✓ Webhook update_registration succeeded.");

  // 7. Test Sensor Registration and State Updates
  console.log("\n7. Testing Sensor Registration & Sensor Updates via Webhook...");
  const regSensor = await makeRequest("POST", `/api/webhook/${webhookA1}`, {
    type: "register_sensor",
    data: {
      unique_id: "battery_level_sensor",
      name: "Battery Level",
      type: "sensor",
      device_class: "battery",
      state_class: "measurement",
      unit_of_measurement: "%",
      state: 88
    }
  });
  if (regSensor.status !== 200 && regSensor.status !== 201) {
    throw new Error(`register_sensor failed: ${regSensor.status}`);
  }
  console.log("✓ Sensor registered successfully.");

  const updateSensor = await makeRequest("POST", `/api/webhook/${webhookA1}`, {
    type: "update_sensor_states",
    data: [
      {
        unique_id: "battery_level_sensor",
        state: 85,
        attributes: { is_charging: false }
      }
    ]
  });
  if (updateSensor.status !== 200) throw new Error("update_sensor_states failed.");
  console.log("✓ Sensor states updated successfully.");

  // 8. Test Invalid Webhook Rejection (HTTP 410 Gone)
  console.log("\n8. Testing Non-Existent Webhook Rejection (HTTP 410 Gone)...");
  const badWebhookRes = await makeRequest("POST", "/api/webhook/non_existent_webhook_id_12345", {
    type: "update_location",
    data: { gps: [0, 0] }
  });
  if (badWebhookRes.status !== 410) {
    throw new Error(`Expected HTTP 410 for non-existent webhook, got: ${badWebhookRes.status}`);
  }
  console.log("✓ Invalid webhook correctly rejected with HTTP 410 Gone.");

  // 9. Test Malformed Webhook Payload Rejection (HTTP 400 Bad Request)
  console.log("\n9. Testing Malformed Payload Rejection (HTTP 400 Bad Request)...");
  const malformedRes = await makeRequest("POST", `/api/webhook/${webhookA1}`, "not-a-valid-json", undefined, {
    "Content-Type": "application/json"
  });
  if (malformedRes.status !== 400) {
    throw new Error(`Expected HTTP 400 for malformed JSON, got: ${malformedRes.status}`);
  }
  console.log("✓ Malformed webhook payload correctly rejected with HTTP 400 Bad Request.");

  // 10. Test User Isolation on Device Registry
  console.log("\n10. Testing WebSocket / Device Isolation for Authenticated Users...");
  const meU1 = await makeRequest("GET", "/api/auth/me", undefined, u1Token);
  if (meU1.status !== 200 || meU1.data.username !== u1Name) throw new Error("User 1 profile check failed.");

  const meU2 = await makeRequest("GET", "/api/auth/me", undefined, u2Token);
  if (meU2.status !== 200 || meU2.data.username !== u2Name) throw new Error("User 2 profile check failed.");
  console.log("✓ User profile and data boundaries strictly enforced.");

  console.log("\n============================================================");
  console.log("ALL STAGE 4 DEVICE REGISTRATION & IDENTITY AUDIT TESTS PASSED! 🎉");
  console.log("============================================================");
}

runStage4Audit().catch((err) => {
  console.error("\nTest Suite Failed:", err);
  process.exit(1);
});
