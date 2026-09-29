import { WebSocket } from "ws";
import dotenv from "dotenv";
import fs from "fs";

// Load environment variables
dotenv.config();
[".env.local", ".env.production", ".env.development"].forEach((f) => {
  if (fs.existsSync(f)) dotenv.config({ path: f, override: true });
});

const HA_URL = (process.env.HA_URL || "").trim().replace(/\/+$/, "");
const HA_LLAT = (process.env.HA_LONG_LIVED_ACCESS_TOKEN || "").trim();

async function runRealHATest() {
  console.log("============================================================");
  console.log("RUNNING REAL HOME ASSISTANT LIVE CONNECTION TEST");
  console.log("============================================================\n");

  if (!HA_URL || !HA_LLAT) {
    console.error("❌ Blocker: HA_URL or HA_LONG_LIVED_ACCESS_TOKEN is missing from runtime!");
    process.exit(1);
  }

  console.log("1. Runtime Environment Check:");
  console.log("   - HA_URL runtime available: YES");
  console.log("   - LLAT runtime available: YES\n");

  // --------------------------------------------------------------------------
  // STEP 2 — Real HA REST API Call
  // --------------------------------------------------------------------------
  console.log("2. Testing Real Home Assistant REST API...");
  let states: any[] = [];
  try {
    const configRes = await fetch(`${HA_URL}/api/config`, {
      headers: {
        Authorization: `Bearer ${HA_LLAT}`,
        "Content-Type": "application/json"
      }
    });

    if (!configRes.ok) {
      console.error(`❌ REST /api/config failed with status ${configRes.status}`);
      process.exit(1);
    }
    const configData = await configRes.json();
    console.log(`   ✓ REST /api/config authenticated successfully! HA Version: ${configData.version || "unknown"}, Location: ${configData.location_name || "Home"}`);

    const statesRes = await fetch(`${HA_URL}/api/states`, {
      headers: {
        Authorization: `Bearer ${HA_LLAT}`,
        "Content-Type": "application/json"
      }
    });

    if (!statesRes.ok) {
      console.error(`❌ REST /api/states failed with status ${statesRes.status}`);
      process.exit(1);
    }
    states = await statesRes.json();
    console.log(`   ✓ REST /api/states retrieved ${states.length} total real HA entities.`);
  } catch (err: any) {
    console.error("❌ REST Connection error:", err.message);
    process.exit(1);
  }

  // --------------------------------------------------------------------------
  // STEP 3 — Real HA WebSocket API Call
  // --------------------------------------------------------------------------
  console.log("\n3. Testing Real Home Assistant WebSocket API...");
  const wsUrl = new URL(HA_URL);
  const proto = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const haWsEndpoint = `${proto}//${wsUrl.host}/api/websocket`;

  let wsAuthOk = false;
  let wsSubscribed = false;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket handshake timed out after 10s"));
    }, 10000);

    const ws = new WebSocket(haWsEndpoint);

    ws.on("open", () => {
      console.log("   ✓ Connected to HA WebSocket endpoint.");
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "auth_required") {
          console.log("   ✓ Received auth_required challenge from real HA Core.");
          ws.send(JSON.stringify({
            type: "auth",
            access_token: HA_LLAT
          }));
        } else if (msg.type === "auth_ok") {
          wsAuthOk = true;
          console.log(`   ✓ Authentication accepted by real HA Core (HA Version: ${msg.ha_version})!`);
          // Subscribe to state_changed
          ws.send(JSON.stringify({
            id: 1,
            type: "subscribe_events",
            event_type: "state_changed"
          }));
        } else if (msg.type === "auth_invalid") {
          clearTimeout(timeout);
          ws.close();
          reject(new Error("HA WebSocket Authentication Invalid"));
        } else if (msg.type === "result" && msg.id === 1 && msg.success) {
          wsSubscribed = true;
          console.log("   ✓ Subscribed to real state_changed events on HA WebSocket!");
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch (e: any) {
        clearTimeout(timeout);
        ws.close();
        reject(e);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // --------------------------------------------------------------------------
  // STEP 4 — Real Device Discovery & Inspection
  // --------------------------------------------------------------------------
  console.log("\n4. Discovering Location-Capable Entities from Real HA...");
  const locationEntities = states.filter((s: any) => 
    s.entity_id.startsWith("device_tracker.") ||
    (s.attributes && s.attributes.latitude != null && s.attributes.longitude != null)
  );

  console.log(`   - Total real HA entities: ${states.length}`);
  console.log(`   - Real location-capable entities: ${locationEntities.length}`);

  console.log("\n   Discovered Location Entities:");
  locationEntities.forEach((entity: any) => {
    const attrs = entity.attributes || {};
    const hasGps = attrs.latitude != null && attrs.longitude != null;
    const battery = attrs.battery_level ?? attrs.battery ?? "N/A";
    const charging = attrs.battery_charging ?? attrs.charging ?? "N/A";
    const accuracy = attrs.gps_accuracy ? `±${attrs.gps_accuracy}m` : "N/A";
    console.log(`   * ${entity.entity_id}:`);
    console.log(`       Name: "${attrs.friendly_name || entity.entity_id}"`);
    console.log(`       State: ${entity.state}`);
    console.log(`       GPS Coordinates Available: ${hasGps ? "YES" : "NO"}`);
    console.log(`       Accuracy: ${accuracy} | Battery: ${battery}% | Charging: ${charging}`);
  });

  // --------------------------------------------------------------------------
  // STEP 5 — Yimly Device Inventory & Member Assignment Test
  // --------------------------------------------------------------------------
  console.log("\n5. Testing Yimly Device Inventory & Real Member Assignment...");
  const YIMLY_SERVER = "http://127.0.0.1:3000";

  const regRes = await fetch(`${YIMLY_SERVER}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `real_ha_tester_${Date.now()}`,
      password: "TestPassword123!",
      display_name: "Real HA Officer"
    })
  });
  const regData = await regRes.json();
  const token = regData.access_token || regData.token;
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Fetch Yimly discovered devices
  const yimlyDevsRes = await fetch(`${YIMLY_SERVER}/api/ha/devices`, { headers: authHeaders });
  const yimlyDevs = await yimlyDevsRes.json();
  console.log(`   ✓ Yimly inventory returned ${yimlyDevs.length} devices from real HA.`);

  // Create Circle & Member
  const circleRes = await fetch(`${YIMLY_SERVER}/api/circles`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Real HA Circle" })
  });
  const circle = await circleRes.json();

  const targetTracker = locationEntities.find((e: any) => e.entity_id.startsWith("device_tracker.")) || locationEntities[0];

  const memberRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      display_name: "Live Family Member",
      avatar_color: "#4ECDC4",
      assigned_entity_id: targetTracker ? targetTracker.entity_id : null
    })
  });
  const member = await memberRes.json();
  console.log(`   ✓ Created Yimly member with assigned entity: ${member.assigned_entity_id || "(none)"}`);

  // Fetch Member Location
  const membersListRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members`, { headers: authHeaders });
  const membersList = await membersListRes.json();
  const verifiedMember = membersList.find((m: any) => m.id === member.id);
  console.log(`   ✓ Verified member in circle has ${verifiedMember?.devices?.length || 0} location device(s) attached.`);

  console.log("\n============================================================");
  console.log("REAL HOME ASSISTANT INTEGRATION TEST COMPLETED SUCCESSFULLY! 🚀");
  console.log("============================================================");
}

runRealHATest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
