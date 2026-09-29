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

async function runStage5Audit() {
  console.log("============================================================");
  console.log("RUNNING STAGE 5 LOCATION, TELEMETRY & ENTITY STATE AUDIT");
  console.log("============================================================");

  const timestamp = Date.now();
  const u1Name = `stg5_user1_${timestamp}`;
  const u2Name = `stg5_user2_${timestamp}`;
  const password = "SecurePassword123!";

  // 1. Account Setup
  console.log("\n1. Setting up User 1 and User 2 accounts...");
  const u1Reg = await makeRequest("POST", "/api/auth/register", {
    username: u1Name,
    password,
    display_name: "Stage 5 User One"
  });
  if (u1Reg.status !== 200) throw new Error(`User 1 registration failed: ${JSON.stringify(u1Reg.data)}`);

  const u2Reg = await makeRequest("POST", "/api/auth/register", {
    username: u2Name,
    password,
    display_name: "Stage 5 User Two"
  });
  if (u2Reg.status !== 200) throw new Error(`User 2 registration failed: ${JSON.stringify(u2Reg.data)}`);

  const u1Login = await makeRequest("POST", "/api/auth/login", { username: u1Name, password });
  const u1Token = u1Login.data.access_token;
  const u1Id = u1Login.data.user_id || u1Login.data.user?.id;

  const u2Login = await makeRequest("POST", "/api/auth/login", { username: u2Name, password });
  const u2Token = u2Login.data.access_token;
  const u2Id = u2Login.data.user_id || u2Login.data.user?.id;
  console.log(`✓ Created User 1 (${u1Name}) and User 2 (${u2Name}).`);

  // 2. Device Registration for User 1
  console.log("\n2. Registering Companion Device for User 1...");
  const device1Id = `stg5_device_${timestamp}`;
  const regDev = await makeRequest("POST", "/api/mobile_app/registrations", {
    app_id: "io.homeassistant.companion.android",
    app_name: "Home Assistant",
    app_version: "2024.1.0",
    device_name: "Pixel 8 Pro Stg5",
    device_id: device1Id,
    manufacturer: "Google",
    model: "Pixel 8 Pro",
    os_name: "Android",
    os_version: "14",
    supports_encryption: false
  }, u1Token);

  if (regDev.status !== 200 && regDev.status !== 201) {
    throw new Error(`Device registration failed: ${JSON.stringify(regDev.data)}`);
  }
  const webhookId = regDev.data.webhook_id;
  console.log(`✓ Device registered with webhook_id: ${webhookId}`);

  // 3. Location Ingestion - HA gps array format
  console.log("\n3. Testing Location Ingestion via 'gps: [lat, lon]' array format...");
  const loc1 = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_location",
    data: {
      gps: [37.7749, -122.4194],
      gps_accuracy: 8,
      altitude: 15.2,
      speed: 1.4,
      bearing: 180.0,
      battery: 89
    }
  });
  if (loc1.status !== 200) throw new Error(`Location update 1 failed: ${loc1.status}`);
  console.log("✓ Location update (gps array format) succeeded with HTTP 200.");

  // 4. Location Ingestion - Standard lat/lon format
  console.log("\n4. Testing Location Ingestion via direct latitude/longitude format...");
  const loc2 = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_location",
    data: {
      latitude: 37.7755,
      longitude: -122.4180,
      gps_accuracy: 5,
      battery: 88
    }
  });
  if (loc2.status !== 200) throw new Error(`Location update 2 failed: ${loc2.status}`);
  console.log("✓ Location update (direct lat/lon format) succeeded with HTTP 200.");

  // 5. Malformed Payload Handling
  console.log("\n5. Testing Malformed Webhook Payload Handling...");
  const invalidPayload = await makeRequest("POST", `/api/webhook/${webhookId}`, "not_a_valid_json_string", undefined, {
    "Content-Type": "application/json"
  });
  if (invalidPayload.status !== 400) {
    throw new Error(`Expected HTTP 400 for malformed payload, got: ${invalidPayload.status}`);
  }
  console.log("✓ Malformed webhook payload safely rejected with HTTP 400.");

  // 6. Sensor Registration & Updates
  console.log("\n6. Testing Sensor Registration & Telemetry State Updates...");
  const regSensor1 = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "register_sensor",
    data: {
      unique_id: "battery_state_sensor",
      name: "Battery State",
      type: "sensor",
      device_class: "battery",
      state_class: "measurement",
      unit_of_measurement: "%",
      state: 88
    }
  });
  if (regSensor1.status !== 200 && regSensor1.status !== 201) {
    throw new Error(`Sensor registration failed: ${regSensor1.status}`);
  }

  const regSensor2 = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "register_sensor",
    data: {
      unique_id: "wifi_ssid_sensor",
      name: "WiFi Connection",
      type: "sensor",
      icon: "mdi:wifi",
      state: "Home_5GHz"
    }
  });
  if (regSensor2.status !== 200 && regSensor2.status !== 201) {
    throw new Error(`Sensor 2 registration failed: ${regSensor2.status}`);
  }
  console.log("✓ Multiple sensors registered for device.");

  const updateSensors = await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_sensor_states",
    data: [
      {
        unique_id: "battery_state_sensor",
        state: 86,
        attributes: { is_charging: true }
      },
      {
        unique_id: "wifi_ssid_sensor",
        state: "Office_Mesh",
        attributes: { bssid: "00:11:22:33:44:55" }
      }
    ]
  });
  if (updateSensors.status !== 200) throw new Error(`Sensor updates failed: ${updateSensors.status}`);
  console.log("✓ Sensor state batch update succeeded.");

  // 7. Device Tracker Entity Verification
  console.log("\n7. Verifying Device Tracker Entity State and Attributes...");
  const statesRes = await makeRequest("GET", "/api/states", undefined, u1Token);
  if (statesRes.status !== 200 || !Array.isArray(statesRes.data)) {
    throw new Error("Failed to fetch entity states.");
  }
  const trackerEntity = statesRes.data.find((e: any) => e.entity_id && e.entity_id.startsWith("device_tracker."));
  if (!trackerEntity) throw new Error("No device_tracker entity found in user state.");
  const lat = trackerEntity.attributes?.latitude ?? trackerEntity.latitude;
  const lon = trackerEntity.attributes?.longitude ?? trackerEntity.longitude;
  if (lat === undefined || lon === undefined) {
    throw new Error(`Device tracker entity missing coordinates: ${JSON.stringify(trackerEntity)}`);
  }
  console.log(`✓ Device tracker '${trackerEntity.entity_id}' verified with state: ${trackerEntity.state} (lat: ${lat}, lon: ${lon}).`);

  // 8. Location History & Authorization Scoping
  console.log("\n8. Testing Location History API & User Scoping Boundaries...");
  const histU1 = await makeRequest("GET", "/api/history/period", undefined, u1Token);
  if (histU1.status !== 200 || !Array.isArray(histU1.data) || histU1.data.length === 0) {
    throw new Error(`User 1 history query failed: ${JSON.stringify(histU1.data)}`);
  }
  console.log(`✓ User 1 retrieved own location history (${histU1.data.length} records).`);

  const histU2 = await makeRequest("GET", "/api/history/period", undefined, u2Token);
  if (histU2.status !== 200 || !Array.isArray(histU2.data)) {
    throw new Error(`User 2 history query failed: ${JSON.stringify(histU2.data)}`);
  }
  // User 2 has not registered any device yet, so history should be empty or isolated
  const hasLeakedU1Data = histU2.data.some((h: any) => h.entity_id && h.entity_id.includes(device1Id));
  if (hasLeakedU1Data) {
    throw new Error("User 1 location history leaked to User 2!");
  }
  console.log("✓ User 2 default history query correctly scoped (no User 1 telemetry leakage).");

  // 9. State Consistency Lifecycle Sequence
  console.log("\n9. Testing High-Frequency State Consistency Sequence...");
  for (let i = 0; i < 5; i++) {
    const rapidLoc = await makeRequest("POST", `/api/webhook/${webhookId}`, {
      type: "update_location",
      data: {
        gps: [37.7749 + i * 0.0005, -122.4194 + i * 0.0005],
        gps_accuracy: 5,
        battery: 85 - i
      }
    });
    if (rapidLoc.status !== 200) throw new Error(`Rapid location update #${i} failed`);
  }
  console.log("✓ Rapid sequence of 5 consecutive telemetry updates processed cleanly.");

  console.log("\n============================================================");
  console.log("ALL STAGE 5 TELEMETRY & ENTITY STATE AUDIT TESTS PASSED! 🎉");
  console.log("============================================================");
}

runStage5Audit().catch((err) => {
  console.error("\nStage 5 Test Suite Failed:", err);
  process.exit(1);
});
