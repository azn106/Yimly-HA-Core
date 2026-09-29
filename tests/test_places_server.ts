import http from "http";
import fs from "fs";
import path from "path";

// Test against local Express server
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

async function runTests() {
  console.log("Starting Places API test suite...");

  // 1. Register and Authenticate user 1
  const user1Name = `place_admin_${Date.now()}`;
  const reg1 = await makeRequest("POST", "/api/auth/register", {
    username: user1Name,
    password: "password123",
    display_name: "Place Admin"
  });
  if (reg1.status !== 200) {
    throw new Error(`Register failed for user 1: ${JSON.stringify(reg1.data)}`);
  }
  const token1 = reg1.data.access_token;
  console.log("✓ User 1 authenticated successfully");

  // 2. Register user 2
  const user2Name = `u2_test_${Date.now()}`;
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
  console.log("✓ User 2 registered & authenticated");

  // 3. Create Circle 1 for User 1
  const circle1Res = await makeRequest("POST", "/api/circles", { name: "Circle One" }, token1);
  const circle1Id = circle1Res.data.id;
  console.log(`✓ Circle 1 created (ID: ${circle1Id})`);

  // 4. Create Circle 2 for User 2
  const circle2Res = await makeRequest("POST", "/api/circles", { name: "Circle Two" }, token2);
  const circle2Id = circle2Res.data.id;
  console.log(`✓ Circle 2 created (ID: ${circle2Id})`);

  // 5. Test unauthenticated request is rejected (401)
  const unauthRes = await makeRequest("GET", `/api/circles/${circle1Id}/places`);
  if (unauthRes.status !== 401) {
    throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);
  }
  console.log("✓ Unauthenticated request rejected with 401");

  // 6. Test non-member access rejected (403)
  const nonMemberRes = await makeRequest("GET", `/api/circles/${circle1Id}/places`, undefined, token2);
  if (nonMemberRes.status !== 403) {
    throw new Error(`Expected 403 for non-member request, got ${nonMemberRes.status}`);
  }
  console.log("✓ Non-member access rejected with 403");

  // 7. Test listing places starts empty (200)
  const emptyListRes = await makeRequest("GET", `/api/circles/${circle1Id}/places`, undefined, token1);
  if (emptyListRes.status !== 200 || !Array.isArray(emptyListRes.data) || emptyListRes.data.length !== 0) {
    throw new Error(`Expected empty list, got ${JSON.stringify(emptyListRes.data)}`);
  }
  console.log("✓ Initial places list is empty []");

  // 8. Test invalid latitude validation (422)
  const badLatRes = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/places`,
    { name: "Bad Lat Place", latitude: 120, longitude: -122.4194, radius: 100 },
    token1
  );
  if (badLatRes.status !== 422) {
    throw new Error(`Expected 422 for invalid latitude, got ${badLatRes.status}`);
  }
  console.log("✓ Invalid latitude rejected with 422");

  // 9. Test invalid longitude validation (422)
  const badLngRes = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/places`,
    { name: "Bad Lng Place", latitude: 37.7749, longitude: 200, radius: 100 },
    token1
  );
  if (badLngRes.status !== 422) {
    throw new Error(`Expected 422 for invalid longitude, got ${badLngRes.status}`);
  }
  console.log("✓ Invalid longitude rejected with 422");

  // 10. Test invalid radius validation (422)
  const badRadRes = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/places`,
    { name: "Bad Radius Place", latitude: 37.7749, longitude: -122.4194, radius: -50 },
    token1
  );
  if (badRadRes.status !== 422) {
    throw new Error(`Expected 422 for invalid radius, got ${badRadRes.status}`);
  }
  console.log("✓ Invalid radius rejected with 422");

  // 11. Test Place creation by member (201)
  const createRes = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/places`,
    {
      name: "Home Base",
      address: "100 Market St, San Francisco, CA",
      latitude: 37.7749,
      longitude: -122.4194,
      radius: 150.0,
      icon: "home"
    },
    token1
  );
  if (createRes.status !== 201) {
    throw new Error(`Expected 201 for valid place creation, got ${createRes.status}: ${JSON.stringify(createRes.data)}`);
  }
  const place1 = createRes.data;
  if (place1.name !== "Home Base" || place1.circle_id !== circle1Id || place1.radius !== 150.0) {
    throw new Error(`Place creation response payload mismatch: ${JSON.stringify(place1)}`);
  }
  console.log(`✓ Place created successfully (ID: ${place1.id}, Name: "${place1.name}")`);

  // 12. Test listing places (200)
  const listRes = await makeRequest("GET", `/api/circles/${circle1Id}/places`, undefined, token1);
  if (listRes.status !== 200 || listRes.data.length !== 1) {
    throw new Error(`Expected list with 1 place, got ${JSON.stringify(listRes.data)}`);
  }
  console.log("✓ Places list returns created place");

  // 13. Test retrieving place by ID (200)
  const getRes = await makeRequest("GET", `/api/circles/${circle1Id}/places/${place1.id}`, undefined, token1);
  if (getRes.status !== 200 || getRes.data.id !== place1.id) {
    throw new Error(`Expected 200 for place GET, got ${getRes.status}`);
  }
  console.log("✓ Place retrieved by ID");

  // 14. Test cross-circle access prevention (404/403)
  const crossGetRes = await makeRequest("GET", `/api/circles/${circle2Id}/places/${place1.id}`, undefined, token2);
  if (crossGetRes.status !== 404) {
    throw new Error(`Expected 404 for place from another circle, got ${crossGetRes.status}`);
  }
  console.log("✓ Cross-circle place access prevented with 404");

  // 15. Test updating place (200)
  const updateRes = await makeRequest(
    "PUT",
    `/api/circles/${circle1Id}/places/${place1.id}`,
    { name: "Updated Home Base", radius: 250.0 },
    token1
  );
  if (updateRes.status !== 200 || updateRes.data.name !== "Updated Home Base" || updateRes.data.radius !== 250.0) {
    throw new Error(`Expected updated place, got ${JSON.stringify(updateRes.data)}`);
  }
  console.log("✓ Place updated successfully");

  // 16. Test deleting place (200)
  const deleteRes = await makeRequest("DELETE", `/api/circles/${circle1Id}/places/${place1.id}`, undefined, token1);
  if (deleteRes.status !== 200) {
    throw new Error(`Expected 200 for place deletion, got ${deleteRes.status}`);
  }
  console.log("✓ Place deleted successfully");

  // Confirm deleted
  const getDeletedRes = await makeRequest("GET", `/api/circles/${circle1Id}/places/${place1.id}`, undefined, token1);
  if (getDeletedRes.status !== 404) {
    throw new Error(`Expected 404 for deleted place, got ${getDeletedRes.status}`);
  }
  console.log("✓ Verified deleted place returns 404");

  // 17. Test circle deletion cleans up places
  const createForDelRes = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/places`,
    { name: "Temp Place", latitude: 37.77, longitude: -122.41, radius: 100 },
    token1
  );
  if (createForDelRes.status !== 201) {
    throw new Error("Failed to create temporary place for circle deletion test");
  }

  const delCircleRes = await makeRequest("DELETE", `/api/circles/${circle1Id}`, undefined, token1);
  if (delCircleRes.status !== 200) {
    throw new Error(`Failed to delete circle: ${delCircleRes.status}`);
  }
  console.log("✓ Circle deleted");

  // Accessing places for deleted circle returns 403 or 404
  const placesAfterCircleDel = await makeRequest("GET", `/api/circles/${circle1Id}/places`, undefined, token1);
  if (placesAfterCircleDel.status !== 403 && placesAfterCircleDel.status !== 404) {
    throw new Error(`Expected 403/404 for deleted circle places, got ${placesAfterCircleDel.status}`);
  }
  console.log("✓ Verified places cleaned up when circle is deleted");

  console.log("\nALL PLACES API TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
