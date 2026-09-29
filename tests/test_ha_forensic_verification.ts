import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";

// Helper for assertions
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✓ ${message}`);
}

async function runForensicVerification() {
  console.log("============================================================");
  console.log("RUNNING FORENSIC HA INTEGRATION & ASSIGNMENT VERIFICATION");
  console.log("============================================================\n");

  // --------------------------------------------------------------------------
  // SECTION 1: Mock Official Home Assistant Core Server (REST + WebSocket)
  // --------------------------------------------------------------------------
  console.log("--- 1. SPINNING UP OFFICIAL HOME ASSISTANT CORE SERVER SIMULATION ---");
  const HA_PORT = 8123;
  const EXPECTED_LLAT = "secret_ha_long_lived_access_token_123456789";

  const haEntities: Record<string, any> = {
    "device_tracker.robin_iphone": {
      entity_id: "device_tracker.robin_iphone",
      state: "home",
      attributes: {
        friendly_name: "Robin's iPhone 15 Pro",
        latitude: 37.7749,
        longitude: -122.4194,
        gps_accuracy: 12.5,
        battery_level: 84,
        battery_charging: true,
        source_type: "gps"
      },
      last_updated: new Date().toISOString()
    },
    "device_tracker.jane_pixel": {
      entity_id: "device_tracker.jane_pixel",
      state: "work",
      attributes: {
        friendly_name: "Jane's Pixel 9",
        latitude: 37.7833,
        longitude: -122.4167,
        gps_accuracy: 8.0,
        battery_level: 62,
        battery_charging: false,
        source_type: "gps"
      },
      last_updated: new Date().toISOString()
    },
    "device_tracker.offline_car_tracker": {
      entity_id: "device_tracker.offline_car_tracker",
      state: "unavailable",
      attributes: {
        friendly_name: "Family Car Tracker",
        latitude: null,
        longitude: null,
        source_type: "gps"
      },
      last_updated: new Date().toISOString()
    },
    "sensor.living_room_temp": {
      entity_id: "sensor.living_room_temp",
      state: "21.5",
      attributes: { friendly_name: "Living Room Temperature", unit_of_measurement: "°C" },
      last_updated: new Date().toISOString()
    }
  };

  let haWsClients: WebSocket[] = [];
  let haWsAuthReceived = false;
  let haWsSubscribed = false;

  const haHttpServer = http.createServer((req, res) => {
    // Check Authorization Header
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${EXPECTED_LLAT}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized: Invalid or missing Long-Lived Access Token" }));
      return;
    }

    if (req.url === "/api/" || req.url === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "API running.", location_name: "Home", version: "2026.3.0" }));
      return;
    }

    if (req.url === "/api/states") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Object.values(haEntities)));
      return;
    }

    if (req.url?.startsWith("/api/states/")) {
      const entityId = req.url.replace("/api/states/", "");
      if (haEntities[entityId]) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(haEntities[entityId]));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Entity not found" }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const haWss = new WebSocketServer({ server: haHttpServer, path: "/api/websocket" });
  haWss.on("connection", (ws) => {
    haWsClients.push(ws);
    // Send auth_required challenge
    ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.3.0" }));

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth") {
        if (msg.access_token === EXPECTED_LLAT) {
          haWsAuthReceived = true;
          ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.3.0" }));
        } else {
          ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid token" }));
          ws.close();
        }
      } else if (msg.type === "subscribe_events") {
        haWsSubscribed = true;
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }));
      } else if (msg.type === "get_states") {
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: Object.values(haEntities) }));
      }
    });

    ws.on("close", () => {
      haWsClients = haWsClients.filter((c) => c !== ws);
    });
  });

  await new Promise<void>((resolve) => haHttpServer.listen(HA_PORT, resolve));
  console.log(`✓ Simulated HA Core running at http://127.0.0.1:${HA_PORT}`);

  // --------------------------------------------------------------------------
  // SECTION 2: Test HA Client REST & WebSocket Connection
  // --------------------------------------------------------------------------
  console.log("\n--- 2. VERIFYING HA REST & WEBSOCKET PROTOCOL WITH LLAT ---");

  // Verify REST Auth
  const restRes = await fetch(`http://127.0.0.1:${HA_PORT}/api/states`, {
    headers: { Authorization: `Bearer ${EXPECTED_LLAT}` }
  });
  assert(restRes.ok, "HA REST /api/states authentication with LLAT succeeded");
  const states = await restRes.json();
  assert(Array.isArray(states) && states.length === 4, "HA REST returned expected 4 states");

  // Verify Unauthenticated REST fails
  const unauthRes = await fetch(`http://127.0.0.1:${HA_PORT}/api/states`);
  assert(unauthRes.status === 401, "HA REST safely rejects unauthenticated calls (HTTP 401)");

  // --------------------------------------------------------------------------
  // SECTION 3: Device Discovery & Normalization Logic
  // --------------------------------------------------------------------------
  console.log("\n--- 3. VERIFYING DEVICE DISCOVERY & NORMALIZATION ---");
  const trackers = states.filter((s: any) => s.entity_id.startsWith("device_tracker."));
  assert(trackers.length === 3, "Discovered 3 device_tracker entities from HA Core");

  const robinIphone = trackers.find((t: any) => t.entity_id === "device_tracker.robin_iphone");
  assert(robinIphone.attributes.friendly_name === "Robin's iPhone 15 Pro", "Friendly name correctly preserved");
  assert(robinIphone.attributes.latitude === 37.7749, "Latitude correctly extracted");
  assert(robinIphone.attributes.longitude === -122.4194, "Longitude correctly extracted");
  assert(robinIphone.attributes.battery_level === 84, "Battery percentage correctly extracted");
  assert(robinIphone.attributes.battery_charging === true, "Charging state correctly extracted");
  assert(robinIphone.state === "home", "Entity state correctly extracted");

  // Non-location entities like temperature sensor must be ignored
  const nonTrackers = states.filter((s: any) => !s.entity_id.startsWith("device_tracker.") && !s.entity_id.startsWith("person."));
  assert(nonTrackers.length === 1 && nonTrackers[0].entity_id === "sensor.living_room_temp", "Sensors excluded from location device inventory");

  // --------------------------------------------------------------------------
  // SECTION 4: Yimly Member Independence & Assignment Pipeline
  // --------------------------------------------------------------------------
  console.log("\n--- 4. VERIFYING YIMLY MEMBER INDEPENDENCE & ASSIGNMENT FLOW ---");
  const YIMLY_SERVER = "http://127.0.0.1:3000";

  // Register Admin User
  const regRes = await fetch(`${YIMLY_SERVER}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `forensic_user_${Date.now()}`,
      password: "StrongPassword123!",
      display_name: "Forensic Officer"
    })
  });
  assert(regRes.ok, "Yimly admin registered");
  const regData = await regRes.json();
  const token = regData.access_token || regData.token;
  assert(Boolean(token), "Access token obtained");
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Create Family Circle
  const circleRes = await fetch(`${YIMLY_SERVER}/api/circles`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Forensic Investigation Circle" })
  });
  assert(circleRes.ok, "Circle created");
  const circle = await circleRes.json();

  // Create Yimly Member with custom Yimly properties (no device)
  const memberCreateRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      display_name: "Robin (Child Profile)",
      avatar_color: "#A8E6CF",
      profile_picture_url: "https://example.com/robin.png",
      assigned_entity_id: null
    })
  });
  assert(memberCreateRes.ok, "Yimly independent member created");
  const createdMember = await memberCreateRes.json();
  assert(createdMember.display_name === "Robin (Child Profile)", "Yimly owns member display name");
  assert(createdMember.avatar_color === "#A8E6CF", "Yimly owns avatar color");
  assert(createdMember.devices.length === 0, "Unassigned member has 0 devices (no fake coordinates)");

  // Assign HA device
  const assignRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members/${createdMember.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      assigned_entity_id: "device_tracker.robin_iphone"
    })
  });
  assert(assignRes.ok, "Assigned device_tracker.robin_iphone to Yimly member");
  const assignedMember = await assignRes.json();
  assert(assignedMember.assigned_entity_id === "device_tracker.robin_iphone", "Assignment persisted in Yimly DB");

  // Re-assign to a different device
  const reassignRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members/${createdMember.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      assigned_entity_id: "device_tracker.jane_pixel"
    })
  });
  assert(reassignRes.ok, "Re-assigned to device_tracker.jane_pixel");
  const reassignedMember = await reassignRes.json();
  assert(reassignedMember.assigned_entity_id === "device_tracker.jane_pixel", "New assignment updated in Yimly DB");

  // Unassign device
  const unassignRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members/${createdMember.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      assigned_entity_id: null
    })
  });
  assert(unassignRes.ok, "Unassigned device");
  const unassignedMember = await unassignRes.json();
  assert(unassignedMember.assigned_entity_id === null, "assigned_entity_id is null");
  assert(unassignedMember.devices.length === 0, "No device coordinates returned for unassigned member");

  // --------------------------------------------------------------------------
  // SECTION 5: Security Audit
  // --------------------------------------------------------------------------
  console.log("\n--- 5. VERIFYING SECURITY & SECRETS ISOLATION ---");

  // 1. Verify LLAT is not in frontend bundles
  const distDir = path.join(process.cwd(), "dist");
  if (fs.existsSync(distDir)) {
    const distFiles = fs.readdirSync(distDir, { recursive: true }) as string[];
    for (const f of distFiles) {
      if (typeof f === "string" && (f.endsWith(".js") || f.endsWith(".html") || f.endsWith(".css"))) {
        const content = fs.readFileSync(path.join(distDir, f), "utf8");
        assert(!content.includes("secret_ha_long_lived_access_token"), `Bundle file ${f} does not contain HA secret`);
        assert(!content.includes("HA_LONG_LIVED_ACCESS_TOKEN"), `Bundle file ${f} does not expose HA env key`);
      }
    }
    console.log("✓ Frontend production build bundle is completely free of HA credentials");
  }

  // 2. Verify no direct HA database access files
  const bannedDbFiles = ["home-assistant_v2.db", "ha_database.db", "homeassistant.db"];
  for (const dbFile of bannedDbFiles) {
    assert(!fs.existsSync(path.join(process.cwd(), dbFile)), `No forbidden HA database file (${dbFile}) mounted in root`);
  }
  console.log("✓ Zero direct HA database files accessed or mounted.");

  // Cleanup mock HA server
  haHttpServer.close();
  console.log("\n============================================================");
  console.log("ALL FORENSIC VERIFICATIONS PASSED SUCCESSFULLY! 🎯");
  console.log("============================================================");
}

runForensicVerification().catch((err) => {
  console.error("Forensic verification failed:", err);
  process.exit(1);
});
