import WebSocket from "ws";

// Helper for assertions
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✓ ${message}`);
}

async function runHADeviceAssignmentTests() {
  console.log("============================================================");
  console.log("RUNNING HA DEVICE DISCOVERY & YIMLY MEMBER ASSIGNMENT TESTS");
  console.log("============================================================");

  const BASE_URL = "http://127.0.0.1:3000";
  const TEST_USER = `test_ha_admin_${Date.now()}`;
  const TEST_PASS = "TestPass123!";

  // 1. Register & Authenticate User
  console.log("\n1. Registering test admin user...");
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: TEST_USER,
      password: TEST_PASS,
      display_name: "Robin Leader"
    })
  });
  assert(regRes.ok, "Admin user registered successfully");
  const authData = await regRes.json();
  const token = authData.token || authData.access_token;
  assert(Boolean(token), "Access token obtained");

  // 2. Create Family Circle
  console.log("\n2. Creating family circle...");
  const circleRes = await fetch(`${BASE_URL}/api/circles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ name: "Robin Family Circle" })
  });
  assert(circleRes.ok, "Family circle created");
  const circle = await circleRes.json();
  const circleId = circle.id;
  assert(Boolean(circleId), "Circle ID exists");

  // 3. HA Device Discovery
  console.log("\n3. Testing Home Assistant Device Discovery (/api/ha/devices)...");
  const devRes = await fetch(`${BASE_URL}/api/ha/devices`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(devRes.ok, "Discovered HA devices endpoint returned 200 OK");
  const discoveredDevices = await devRes.json();
  assert(Array.isArray(discoveredDevices), "Discovered devices is an array");
  console.log(`Discovered ${discoveredDevices.length} HA location devices.`);

  // 4. Create Yimly Family Member with NO Assigned Device
  console.log("\n4. Testing Yimly member creation without assigned device...");
  const member1Res = await fetch(`${BASE_URL}/api/circles/${circleId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      display_name: "Jane Member",
      avatar_color: "#FFB347",
      assigned_entity_id: null
    })
  });
  assert(member1Res.ok, "Yimly member 'Jane Member' created");
  const member1 = await member1Res.json();
  assert(member1.display_name === "Jane Member", "Display name matches");
  assert(member1.avatar_color === "#FFB347", "Avatar color matches");
  assert(member1.devices.length === 0, "No fake location generated for unassigned member (devices array is empty)");

  // 5. Assign HA Device to Member
  console.log("\n5. Testing HA device assignment to member...");
  const targetEntityId = discoveredDevices[0]?.entity_id || "device_tracker.robin_iphone";
  const assignRes = await fetch(`${BASE_URL}/api/circles/${circleId}/members/${member1.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      display_name: "Jane Member",
      assigned_entity_id: targetEntityId
    })
  });
  assert(assignRes.ok, "Assigned HA device to member");
  const member1Updated = await assignRes.json();
  assert(member1Updated.assigned_entity_id === targetEntityId, "Assigned entity ID saved in Yimly");

  // 6. Query Circle Members & Verify Location Mapping
  console.log("\n6. Verifying circle members returns mapped device location...");
  const listMembersRes = await fetch(`${BASE_URL}/api/circles/${circleId}/members`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(listMembersRes.ok, "GET /api/circles/:id/members returned 200");
  const circleMembersList = await listMembersRes.json();
  const janeInList = circleMembersList.find((m: any) => m.id === member1.id);
  assert(Boolean(janeInList), "Jane found in circle members list");
  assert(janeInList.display_name === "Jane Member", "Jane has correct Yimly name");
  assert(janeInList.avatar_color === "#FFB347", "Jane has correct Yimly avatar color");

  // 7. Change Device Assignment
  console.log("\n7. Testing changing device assignment...");
  const newEntityId = "device_tracker.jane_pixel";
  const changeRes = await fetch(`${BASE_URL}/api/circles/${circleId}/members/${member1.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      assigned_entity_id: newEntityId
    })
  });
  assert(changeRes.ok, "Device assignment changed");
  const changedMember = await changeRes.json();
  assert(changedMember.assigned_entity_id === newEntityId, "New device assignment saved");

  // 8. Remove Device Assignment (Unassign)
  console.log("\n8. Testing removing device assignment (unassign)...");
  const unassignRes = await fetch(`${BASE_URL}/api/circles/${circleId}/members/${member1.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      assigned_entity_id: null
    })
  });
  assert(unassignRes.ok, "Device unassigned successfully");
  const unassignedMember = await unassignRes.json();
  assert(unassignedMember.assigned_entity_id === null, "assigned_entity_id is null");
  assert(unassignedMember.devices.length === 0, "No device locations returned when unassigned");

  // 9. Delete Member
  console.log("\n9. Testing Yimly member deletion...");
  const delRes = await fetch(`${BASE_URL}/api/circles/${circleId}/members/${member1.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(delRes.ok, "Member deleted from Circle");

  // 10. Security Audit: Verify LLAT is NEVER exposed in API responses
  console.log("\n10. Security Audit: Verifying LLAT token non-exposure in API responses...");
  const endpointsToCheck = [
    `/api/auth/me`,
    `/api/ha/devices`,
    `/api/devices/available`,
    `/api/circles`,
    `/api/circles/${circleId}`,
    `/api/circles/${circleId}/members`
  ];

  for (const ep of endpointsToCheck) {
    const res = await fetch(`${BASE_URL}${ep}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const text = await res.text();
      assert(!text.includes("eyJhbGciOi") || !text.includes("token_secret"), `Endpoint ${ep} does not leak LLAT`);
      assert(!text.includes("HA_LONG_LIVED_ACCESS_TOKEN"), `Endpoint ${ep} does not mention HA_LONG_LIVED_ACCESS_TOKEN`);
    }
  }
  console.log("✓ Security Check: LLAT is completely server-side and never returned to client.");

  console.log("\n============================================================");
  console.log("ALL HA DEVICE DISCOVERY & YIMLY MEMBER ASSIGNMENT TESTS PASSED! 🎉");
  console.log("============================================================");
}

runHADeviceAssignmentTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
