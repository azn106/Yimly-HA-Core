import http from "http";

const BASE_URL = "http://127.0.0.1:3000";

function makeRequest(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const postData = body ? JSON.stringify(body) : "";

    const headers: Record<string, string> = {};
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(postData).toString();
    }
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          try {
            const data = rawData ? JSON.parse(rawData) : {};
            resolve({ status: res.statusCode || 500, data });
          } catch (e) {
            resolve({ status: res.statusCode || 500, data: rawData });
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runDeleteDeviceTests() {
  console.log("Starting Delete Device API Test Suite...");

  // 1. Register User 1
  const ts = Date.now();
  const user1 = `dev_user1_${ts}`;
  const pass1 = "secret123456";

  const reg1 = await makeRequest("POST", "/api/auth/register", {
    username: user1,
    display_name: "Device User 1",
    password: pass1
  });
  if (reg1.status !== 200 || !reg1.data.access_token) {
    throw new Error(`Failed to register user 1: ${JSON.stringify(reg1.data)}`);
  }
  const token1 = reg1.data.access_token;
  console.log("✓ User 1 registered and authenticated");

  // 2. Register User 2 for authorization checks
  const user2 = `dev_user2_${ts}`;
  const reg2 = await makeRequest("POST", "/api/auth/register", {
    username: user2,
    display_name: "Device User 2",
    password: pass1
  });
  const token2 = reg2.data.access_token;
  console.log("✓ User 2 registered and authenticated");

  // 3. User 1 fetches devices (auto-provisions primary device tracker)
  const getDevs1 = await makeRequest("GET", "/api/devices", undefined, token1);
  if (getDevs1.status !== 200 || !Array.isArray(getDevs1.data) || getDevs1.data.length === 0) {
    throw new Error(`Failed to get devices for user 1: ${JSON.stringify(getDevs1.data)}`);
  }
  const primaryDev = getDevs1.data[0];
  console.log(`✓ Initial device tracker found: ${primaryDev.entity_id}`);

  // 4. Register a second device via mobile_app registration
  const regMobileDev = await makeRequest(
    "POST",
    "/api/mobile_app/registrations",
    {
      device_id: `pixel_phone_${ts}`,
      app_id: "io.homeassistant.companion.android",
      app_name: "Home Assistant",
      app_version: "2026.9.1",
      device_name: "Google Pixel 9 Pro",
      manufacturer: "Google",
      model: "Pixel 9 Pro",
      os_name: "Android",
      os_version: "15",
      supports_encryption: false,
      app_data: {}
    },
    token1
  );
  if (regMobileDev.status !== 201 || !regMobileDev.data.webhook_id) {
    throw new Error(`Failed to register mobile device: ${JSON.stringify(regMobileDev.data)}`);
  }
  console.log("✓ Registered secondary device via mobile_app registration");

  // Push location telemetry for secondary device to register entity
  const webhookId = regMobileDev.data.webhook_id;
  await makeRequest("POST", `/api/webhook/${webhookId}`, {
    type: "update_location",
    data: {
      gps: [37.7749, -122.4194],
      gps_accuracy: 10,
      battery: 85
    }
  });

  // Verify both devices exist
  const getDevsAfter2 = await makeRequest("GET", "/api/devices", undefined, token1);
  if (getDevsAfter2.data.length < 2) {
    throw new Error(`Expected at least 2 devices, got ${getDevsAfter2.data.length}`);
  }
  const deviceA = getDevsAfter2.data[0];
  const deviceB = getDevsAfter2.data[1];
  console.log(`✓ Confirmed 2 devices exist: [${deviceA.entity_id}, ${deviceB.entity_id}]`);

  // 5. Security: Unauthenticated deletion rejection
  const unauthDel = await makeRequest("DELETE", `/api/devices/${encodeURIComponent(deviceA.entity_id)}`);
  if (unauthDel.status !== 401) {
    throw new Error(`Expected 401 for unauthenticated deletion, got ${unauthDel.status}`);
  }
  console.log("✓ Unauthenticated deletion rejected with 401");

  // 6. Security: Cross-user deletion rejection (User 2 attempting to delete User 1's device)
  const crossUserDel = await makeRequest(
    "DELETE",
    `/api/devices/${encodeURIComponent(deviceA.entity_id)}`,
    undefined,
    token2
  );
  if (crossUserDel.status !== 404) {
    throw new Error(`Expected 404 for cross-user deletion attempt, got ${crossUserDel.status}`);
  }
  console.log("✓ Cross-user deletion rejected with 404");

  // 7. Delete ONLY Device A
  console.log(`Deleting device A (${deviceA.entity_id})...`);
  const delRes = await makeRequest(
    "DELETE",
    `/api/devices/${encodeURIComponent(deviceA.entity_id)}`,
    undefined,
    token1
  );
  if (delRes.status !== 200) {
    throw new Error(`Device deletion failed with status ${delRes.status}: ${JSON.stringify(delRes.data)}`);
  }
  console.log("✓ DELETE /api/devices/:entity_id returned 200 OK");

  // 8. Verify Device A is deleted and Device B remains intact
  const getDevsFinal = await makeRequest("GET", "/api/devices", undefined, token1);
  const foundA = getDevsFinal.data.find((d: any) => d.entity_id === deviceA.entity_id);
  const foundB = getDevsFinal.data.find((d: any) => d.entity_id === deviceB.entity_id);

  if (foundA) {
    throw new Error(`Device A (${deviceA.entity_id}) was NOT deleted!`);
  }
  if (!foundB) {
    throw new Error(`Device B (${deviceB.entity_id}) was erroneously deleted or modified!`);
  }
  console.log(`✓ Verified Device A (${deviceA.entity_id}) permanently removed.`);
  console.log(`✓ Verified Device B (${deviceB.entity_id}) remains completely intact.`);

  // 9. Verify deleting a non-existent device returns 404
  const delNonExistent = await makeRequest(
    "DELETE",
    "/api/devices/device_tracker.non_existent_id",
    undefined,
    token1
  );
  if (delNonExistent.status !== 404) {
    throw new Error(`Expected 404 for non-existent device, got ${delNonExistent.status}`);
  }
  console.log("✓ Non-existent device deletion safely rejected with 404");

  console.log("\n============================================================");
  console.log("ALL DELETE DEVICE TESTS PASSED SUCCESSFULLY! 🎉");
  console.log("============================================================\n");
}

runDeleteDeviceTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
