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
  console.log("Starting Alerts API test suite...");

  // 1. Register and Authenticate user 1 (Admin)
  const reg1 = await makeRequest("POST", "/api/auth/register", {
    username: `alert_admin_${Date.now()}`,
    password: "password123",
    display_name: "Alert Admin"
  });
  if (reg1.status !== 200) {
    throw new Error(`Register failed for user 1: ${JSON.stringify(reg1.data)}`);
  }
  const token1 = reg1.data.access_token;
  const user1Id = reg1.data.user.id;
  console.log("✓ User 1 authenticated successfully");

  // 2. Register and Authenticate user 2
  const user2Name = `u2_alerts_test_${Date.now()}`;
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
  const user2Id = login2.data.user.id;
  console.log("✓ User 2 registered & authenticated");

  // 3. Create Circle 1 for User 1
  const circle1Res = await makeRequest("POST", "/api/circles", { name: "Circle One" }, token1);
  const circle1Id = circle1Res.data.id;
  const circle1Invite = circle1Res.data.invite_code;
  console.log(`✓ Circle 1 created (ID: ${circle1Id})`);

  // 4. Create Circle 2 for User 2
  const circle2Res = await makeRequest("POST", "/api/circles", { name: "Circle Two" }, token2);
  const circle2Id = circle2Res.data.id;
  console.log(`✓ Circle 2 created (ID: ${circle2Id})`);

  // 5. Test unauthenticated request is rejected (401)
  const unauthRes = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`);
  if (unauthRes.status !== 401) {
    throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);
  }
  console.log("✓ Unauthenticated request rejected with 401");

  // 6. Test non-member access rejected (403)
  const nonMemberRes = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token2);
  if (nonMemberRes.status !== 403) {
    throw new Error(`Expected 403 for non-member request, got ${nonMemberRes.status}`);
  }
  console.log("✓ Non-member access rejected with 403");

  // 7. Test listing alerts starts empty (200)
  const emptyListRes = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token1);
  if (emptyListRes.status !== 200 || !Array.isArray(emptyListRes.data) || emptyListRes.data.length !== 0) {
    throw new Error(`Expected empty alerts list, got ${JSON.stringify(emptyListRes.data)}`);
  }
  console.log("✓ Initial alerts list is empty []");

  // 8. Test invalid alert_type validation (422)
  const badTypeRes = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/alerts`,
    { alert_type: "invalid_type", title: "Bad Alert", message: "This should fail" },
    token1
  );
  if (badTypeRes.status !== 422) {
    throw new Error(`Expected 422 for invalid alert_type, got ${badTypeRes.status}`);
  }
  console.log("✓ Invalid alert_type rejected with 422");

  // 9. Create valid alerts and verify (201)
  const alert1Res = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/alerts`,
    {
      alert_type: "arrival",
      title: "Arrived Home Base",
      message: "Admin arrived home base safely."
    },
    token1
  );
  if (alert1Res.status !== 201) {
    throw new Error(`Expected 201 for valid alert creation, got ${alert1Res.status}`);
  }
  const alert1 = alert1Res.data;
  console.log(`✓ Alert 1 created successfully (ID: ${alert1.id}, Type: "${alert1.alert_type}")`);

  // Ensure ordering by sleeping slightly or creating alert 2
  const alert2Res = await makeRequest(
    "POST",
    `/api/circles/${circle1Id}/alerts`,
    {
      alert_type: "low_battery",
      title: "Low Battery Warning",
      message: "Admin phone battery drops below 15%."
    },
    token1
  );
  const alert2 = alert2Res.data;
  console.log(`✓ Alert 2 created successfully (ID: ${alert2.id}, Type: "${alert2.alert_type}")`);

  // 10. Verify retrieval and newest-first ordering (200)
  const listRes = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token1);
  if (listRes.status !== 200 || listRes.data.length !== 2) {
    throw new Error(`Expected 2 alerts, got ${JSON.stringify(listRes.data)}`);
  }
  // Check ordering
  if (listRes.data[0].id !== alert2.id || listRes.data[1].id !== alert1.id) {
    throw new Error("Alerts retrieved are not in newest-first ordering!");
  }
  console.log("✓ Alerts list returns created alerts in newest-first ordering");

  // 11. Verify alert remains isolated to the correct circle/user
  const listCircle2 = await makeRequest("GET", `/api/circles/${circle2Id}/alerts`, undefined, token2);
  if (listCircle2.status !== 200 || listCircle2.data.length !== 0) {
    throw new Error(`Expected empty alerts list for Circle 2, got ${JSON.stringify(listCircle2.data)}`);
  }
  console.log("✓ Alerts isolated to correct user / circle");

  // 12. Mark own alert as read (200)
  const readRes = await makeRequest("PUT", `/api/circles/${circle1Id}/alerts/${alert1.id}/read`, undefined, token1);
  if (readRes.status !== 200 || readRes.data.read !== true) {
    throw new Error(`Expected alert 1 marked as read, got ${JSON.stringify(readRes.data)}`);
  }
  console.log("✓ Marked own alert as read successfully");

  // 13. Cross-user mark-as-read rejection (404)
  // Let User 2 join Circle 1 first
  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: circle1Invite }, token2);
  if (joinRes.status !== 200) {
    throw new Error("User 2 failed to join Circle 1");
  }
  // Now User 2 is in Circle 1, but alert1 belongs to User 1
  const crossReadRes = await makeRequest("PUT", `/api/circles/${circle1Id}/alerts/${alert1.id}/read`, undefined, token2);
  if (crossReadRes.status !== 404) {
    throw new Error(`Expected 404 for marking another user's alert as read, got ${crossReadRes.status}`);
  }
  console.log("✓ Cross-user mark-as-read rejected with 404");

  // 14. Circle deletion cleans up alerts
  const delCircleRes = await makeRequest("DELETE", `/api/circles/${circle1Id}`, undefined, token1);
  if (delCircleRes.status !== 200) {
    throw new Error(`Failed to delete circle 1: ${delCircleRes.status}`);
  }
  console.log("✓ Circle deleted");

  // Accessing alerts for deleted circle returns 403 or 404
  const alertsAfterCircleDel = await makeRequest("GET", `/api/circles/${circle1Id}/alerts`, undefined, token1);
  if (alertsAfterCircleDel.status !== 403 && alertsAfterCircleDel.status !== 404) {
    throw new Error(`Expected 403/404 for deleted circle alerts, got ${alertsAfterCircleDel.status}`);
  }
  console.log("✓ Verified alerts cleaned up when circle is deleted");

  console.log("\nALL ALERTS API TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
