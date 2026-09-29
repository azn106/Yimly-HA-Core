import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
[".env.local", ".env.production", ".env.development"].forEach((f) => {
  if (fs.existsSync(f)) dotenv.config({ path: f, override: true });
});

const YIMLY_SERVER = "http://127.0.0.1:3000";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

async function runNoFakeDataTests() {
  console.log("============================================================");
  console.log("RUNNING FAKE-DATA-REMOVAL & REAL-HA-ONLY VERIFICATION SUITE");
  console.log("============================================================\n");

  // --------------------------------------------------------------------------
  // TEST 1: Production Startup Does Not Seed Demo Data
  // --------------------------------------------------------------------------
  console.log("--- TEST 1: Clean Database & Startup Verification ---");
  const storeRaw = fs.readFileSync("yimly_store_preview.json", "utf8");
  const parsedStore = JSON.parse(storeRaw);
  assert(!parsedStore.users.some((u: any) => u.username?.includes("admin@yimly.home")), "No hardcoded admin@yimly.home in DB");
  assert(!parsedStore.circle_members.some((m: any) => m.display_name?.includes("Preview")), "No seeded preview members in DB");
  assert(!parsedStore.entity_states.some((e: any) => e.entity_id?.includes("preview_phone")), "No seeded preview phone entity_states in DB");
  assert((parsedStore.location_history || []).length === 0 || !parsedStore.location_history.some((h: any) => h.id?.startsWith("prev_hist_")), "No deterministic preview location history seeded");

  // --------------------------------------------------------------------------
  // TEST 2: Register Real User & Check Clean State
  // --------------------------------------------------------------------------
  console.log("\n--- TEST 2: User Registration & Clean Initial Devices ---");
  const regRes = await fetch(`${YIMLY_SERVER}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `real_clean_user_${Date.now()}`,
      password: "SafePassword123!",
      display_name: "Clean Production User"
    })
  });
  assert(regRes.ok, "User registered successfully");
  const regData = await regRes.json();
  const token = regData.access_token || regData.token;
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // GET /api/devices must NOT auto-provision a fake primary device
  const devicesRes = await fetch(`${YIMLY_SERVER}/api/devices`, { headers: authHeaders });
  assert(devicesRes.ok, "GET /api/devices returned 200 OK");
  const userDevices = await devicesRes.json();
  assert(Array.isArray(userDevices), "User devices is an array");
  assert(!userDevices.some((d: any) => d.entity_id?.includes("admin_preview") || d.entity_id?.includes("preview")), "No preview devices in user device list");

  // --------------------------------------------------------------------------
  // TEST 3: Discovered HA Device Inventory strictly excludes person.* & zone.*
  // --------------------------------------------------------------------------
  console.log("\n--- TEST 3: HA Device Inventory strictly filters to real device_tracker.* ---");
  const haDevsRes = await fetch(`${YIMLY_SERVER}/api/ha/devices`, { headers: authHeaders });
  assert(haDevsRes.ok, "GET /api/ha/devices returned 200 OK");
  const haDevs = await haDevsRes.json();
  assert(Array.isArray(haDevs), "HA devices is an array");

  // Verify all discovered devices start with device_tracker.
  for (const d of haDevs) {
    assert(d.entity_id.startsWith("device_tracker."), `Entity ${d.entity_id} is a genuine device_tracker.* entity`);
    assert(!d.entity_id.startsWith("person."), `Entity ${d.entity_id} is NOT a person.* entity`);
    assert(!d.entity_id.startsWith("zone."), `Entity ${d.entity_id} is NOT a zone.* entity`);
    assert(!d.entity_id.includes("preview_phone"), `Entity ${d.entity_id} is not a fake preview entity`);
  }

  // --------------------------------------------------------------------------
  // TEST 4: Yimly Member Independence (No HA Person Dependency)
  // --------------------------------------------------------------------------
  console.log("\n--- TEST 4: Member Independence & Zero Fake Coordinates for Unassigned Member ---");
  const circleRes = await fetch(`${YIMLY_SERVER}/api/circles`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Real Production Family" })
  });
  assert(circleRes.ok, "Circle created");
  const circle = await circleRes.json();

  const newMemberRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      display_name: "Alice Real",
      avatar_color: "#FFB3BA",
      profile_picture_url: null,
      assigned_entity_id: null
    })
  });
  assert(newMemberRes.ok, "Independent member created without HA Person or assigned device");
  const newMember = await newMemberRes.json();
  assert(newMember.display_name === "Alice Real", "Member display name owned by Yimly");
  assert(newMember.avatar_color === "#FFB3BA", "Member avatar colour owned by Yimly");
  assert(newMember.assigned_entity_id === null, "Member has no assigned device");
  assert(!newMember.devices || newMember.devices.length === 0, "Unassigned member returns 0 devices (NO fake coordinates)");

  // --------------------------------------------------------------------------
  // TEST 5: Assign Real HA Device & Verify Real Coordinates Only
  // --------------------------------------------------------------------------
  console.log("\n--- TEST 5: Assigning Real HA Device & Verifying Coordinates ---");
  if (haDevs.length > 0) {
    const realTargetDev = haDevs[0];
    console.log(`   Assigning real HA device: ${realTargetDev.entity_id} (${realTargetDev.device_name})`);

    const updateRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members/${newMember.id}`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        assigned_entity_id: realTargetDev.entity_id
      })
    });
    assert(updateRes.ok, "Device assigned to member");
    const updatedMember = await updateRes.json();
    assert(updatedMember.assigned_entity_id === realTargetDev.entity_id, "Assignment persisted in Yimly DB");

    // Fetch circle members list
    const circleMembersRes = await fetch(`${YIMLY_SERVER}/api/circles/${circle.id}/members`, { headers: authHeaders });
    assert(circleMembersRes.ok, "Fetched circle members");
    const membersList = await circleMembersRes.json();
    const verifiedMember = membersList.find((m: any) => m.id === newMember.id);
    assert(Boolean(verifiedMember), "Member found in circle members list");

    if (realTargetDev.latitude != null && realTargetDev.longitude != null) {
      assert(verifiedMember.devices.length === 1, "Member has 1 resolved real device location");
      const devLoc = verifiedMember.devices[0];
      assert(devLoc.entity_id === realTargetDev.entity_id, "Resolved entity matches assigned entity");
      assert(typeof devLoc.latitude === "number" && typeof devLoc.longitude === "number", "Real numeric coordinates present");
      assert(devLoc.latitude !== 37.7749 || devLoc.longitude !== -122.4194 || realTargetDev.latitude === 37.7749, "Coordinates are from real HA, not hardcoded dummy SF");
    } else {
      assert(verifiedMember.devices.length === 0, "Device without GPS coordinates correctly returns 0 location devices");
    }
  } else {
    console.log("   (No live device_tracker entities discovered on HA instance - verified 0 devices returned without fabrication)");
  }

  // --------------------------------------------------------------------------
  // TEST 6: Static Codebase Audit (Zero Production Fallbacks)
  // --------------------------------------------------------------------------
  console.log("\n--- TEST 6: Static Audit of Frontend and Server Source Code ---");
  const serverCode = fs.readFileSync("server.ts", "utf8");
  assert(!serverCode.includes("getDeterministicPreviewHistory"), "server.ts has no getDeterministicPreviewHistory function");
  assert(!serverCode.includes("Admin's Preview Phone"), "server.ts has no Admin's Preview Phone string");
  assert(!serverCode.includes("device_tracker.admin_preview_phone"), "server.ts has no device_tracker.admin_preview_phone");

  const mapCode = fs.readFileSync("src/components/MapComponent.tsx", "utf8");
  assert(!mapCode.includes("[Preview] Simulated ping alert"), "MapComponent has no simulated ping bypass");

  console.log("\n============================================================");
  console.log("ALL FAKE-DATA-REMOVAL TESTS PASSED SUCCESSFULLY! 🎉");
  console.log("============================================================\n");
}

runNoFakeDataTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
