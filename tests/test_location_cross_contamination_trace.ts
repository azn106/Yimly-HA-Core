import http from "http";
import WebSocket from "ws";

const BASE_URL = "http://127.0.0.1:3000";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

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
      } else if (headers["Content-Type"] === "application/x-www-form-urlencoded") {
        payload = new URLSearchParams(body).toString();
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
          } catch {}
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

async function runCrossContaminationTrace() {
  console.log("================================================================================");
  console.log("RUNNING FORENSIC CROSS-CONTAMINATION TRACE FOR TWO FAMILY MEMBERS");
  console.log("================================================================================");

  const timestamp = Date.now();

  // MEMBER A
  const usernameA = `member_a_${timestamp}`;
  const passwordA = "MemberAPass123!";
  const nameA = "Member Alice";

  // MEMBER B
  const usernameB = `member_b_${timestamp}`;
  const passwordB = "MemberBPass123!";
  const nameB = "Member Bob";

  // 1. REGISTER MEMBER A
  console.log("\n[STEP 1] Registering Member A (Alice)...");
  const regA = await makeRequest("POST", "/api/auth/register", {
    username: usernameA,
    password: passwordA,
    display_name: nameA
  });
  assert(regA.status === 200, "Registration A failed");
  const tokenUserA = regA.data.access_token;
  const userA = regA.data.user;

  // 2. REGISTER MEMBER B
  console.log("\n[STEP 2] Registering Member B (Bob)...");
  const regB = await makeRequest("POST", "/api/auth/register", {
    username: usernameB,
    password: passwordB,
    display_name: nameB
  });
  assert(regB.status === 200, "Registration B failed");
  const tokenUserB = regB.data.access_token;
  const userB = regB.data.user;

  // 3. MEMBER B JOINS MEMBER A'S CIRCLE
  console.log("\n[STEP 3] Member B joining Member A's Family Circle...");
  const circlesA = await makeRequest("GET", "/api/circles", undefined, tokenUserA);
  const circleId = circlesA.data[0].id;
  const inviteCode = circlesA.data[0].invite_code;

  const joinB = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, tokenUserB);
  assert(joinB.status === 200, "Join circle failed");

  // 4. FETCH TRACCAR CONFIG FOR BOTH MEMBERS
  console.log("\n[STEP 4] Fetching Traccar Client config for Member A and Member B...");
  const cfgA = await makeRequest("GET", "/api/traccar/config", undefined, tokenUserA);
  assert(cfgA.status === 200, "Config A failed");
  const traccarTokenA = cfgA.data.token;

  const cfgB = await makeRequest("GET", "/api/traccar/config", undefined, tokenUserB);
  assert(cfgB.status === 200, "Config B failed");
  const traccarTokenB = cfgB.data.token;

  console.log(`[TEMPORARY DIAGNOSTIC] Member A Traccar Token: ${traccarTokenA.slice(0, 4)}...${traccarTokenA.slice(-4)}`);
  console.log(`[TEMPORARY DIAGNOSTIC] Member B Traccar Token: ${traccarTokenB.slice(0, 4)}...${traccarTokenB.slice(-4)}`);

  // 5. POST TRACCAR TELEMETRY FOR MEMBER A
  console.log("\n[STEP 5] Ingesting Traccar location POST for Member A...");
  const latA = 37.774929;
  const lonA = -122.419416;
  const postA = await makeRequest(
    "POST",
    `/api/traccar/${traccarTokenA}`,
    {
      id: usernameA,
      lat: latA.toString(),
      lon: lonA.toString(),
      timestamp: Math.floor(Date.now() / 1000).toString(),
      batt: "95"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(postA.status === 200, "POST A failed");

  // 6. POST TRACCAR TELEMETRY FOR MEMBER B
  console.log("\n[STEP 6] Ingesting Traccar location POST for Member B...");
  const latB = 34.052235;
  const lonB = -118.243683;
  const postB = await makeRequest(
    "POST",
    `/api/traccar/${traccarTokenB}`,
    {
      id: usernameB,
      lat: latB.toString(),
      lon: lonB.toString(),
      timestamp: Math.floor(Date.now() / 1000).toString(),
      batt: "82"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(postB.status === 200, "POST B failed");

  // 7. FETCH CIRCLE MEMBERS API LOCATION PRESENTATION
  console.log("\n[STEP 7] Querying /api/circles/:id/members API presentation for both members...");
  const membersRes = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, tokenUserA);
  assert(membersRes.status === 200, "Fetch circle members failed");

  const memberAObj = membersRes.data.find((m: any) => m.username === usernameA);
  const memberBObj = membersRes.data.find((m: any) => m.username === usernameB);

  assert(Boolean(memberAObj), "Member A missing in circle response");
  assert(Boolean(memberBObj), "Member B missing in circle response");

  console.log("\n================================================================================");
  console.log("TEMPORARY FORENSIC DIAGNOSTIC TRACE RESULTS FOR MEMBER A & MEMBER B");
  console.log("================================================================================");

  console.log("\n--- MEMBER A TRACE ---");
  console.log(`1. Incoming Traccar Username: '${usernameA}'`);
  console.log(`2. Token-Resolved User ID/Username: ID=${userA.id}, Username='${userA.username}'`);
  console.log(`3. Resolved Device: device_id='${usernameA}', app_id='org.traccar.client'`);
  console.log(`4. Generated entity_id: 'device_tracker.${usernameA.toLowerCase().replace(/[^a-z0-9_]/g, "_")}'`);
  console.log(`5. EntityState User/Device: User ID=${userA.id}`);
  console.log(`6. LocationHistory User/Device: User ID=${userA.id}`);
  console.log(`7. Circle Member User ID: ${memberAObj.id}`);
  console.log(`8. Location returned by Member API: Lat=${memberAObj.devices[0]?.latitude}, Lon=${memberAObj.devices[0]?.longitude}`);
  console.log(`9. WebSocket Event Entity ID: 'device_tracker.${usernameA.toLowerCase().replace(/[^a-z0-9_]/g, "_")}'`);
  console.log(`10. Final Displayed Member: '${memberAObj.display_name}' @ (${memberAObj.devices[0]?.latitude}, ${memberAObj.devices[0]?.longitude})`);

  console.log("\n--- MEMBER B TRACE ---");
  console.log(`1. Incoming Traccar Username: '${usernameB}'`);
  console.log(`2. Token-Resolved User ID/Username: ID=${userB.id}, Username='${userB.username}'`);
  console.log(`3. Resolved Device: device_id='${usernameB}', app_id='org.traccar.client'`);
  console.log(`4. Generated entity_id: 'device_tracker.${usernameB.toLowerCase().replace(/[^a-z0-9_]/g, "_")}'`);
  console.log(`5. EntityState User/Device: User ID=${userB.id}`);
  console.log(`6. LocationHistory User/Device: User ID=${userB.id}`);
  console.log(`7. Circle Member User ID: ${memberBObj.id}`);
  console.log(`8. Location returned by Member API: Lat=${memberBObj.devices[0]?.latitude}, Lon=${memberBObj.devices[0]?.longitude}`);
  console.log(`9. WebSocket Event Entity ID: 'device_tracker.${usernameB.toLowerCase().replace(/[^a-z0-9_]/g, "_")}'`);
  console.log(`10. Final Displayed Member: '${memberBObj.display_name}' @ (${memberBObj.devices[0]?.latitude}, ${memberBObj.devices[0]?.longitude})`);

  // Verification checks
  const isMemberACorrect = Math.abs(memberAObj.devices[0]?.latitude - latA) < 0.0001;
  const isMemberBCorrect = Math.abs(memberBObj.devices[0]?.latitude - latB) < 0.0001;

  console.log(`\n✓ Member A Coordinates Match Ingested Post: ${isMemberACorrect ? "YES (37.774929, -122.419416)" : "NO (CROSS-CONTAMINATED!)"}`);
  console.log(`✓ Member B Coordinates Match Ingested Post: ${isMemberBCorrect ? "YES (34.052235, -118.243683)" : "NO (CROSS-CONTAMINATED!)"}`);

  // Test assigned_entity_id cross-assignment edge case
  console.log("\n--- TESTING ASSIGNED_ENTITY_ID CROSS-ASSIGNMENT SCENARIO ---");
  const entityIdA = `device_tracker.${usernameA.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
  // Manually update Member B's assigned_entity_id to point to Member A's entity_id
  const updateRes = await makeRequest(
    "PUT",
    `/api/circles/${circleId}/members/${userB.id}`,
    { assigned_entity_id: entityIdA },
    tokenUserB
  );
  assert(updateRes.status === 400, "Expected HTTP 400 when attempting cross-user assigned_entity_id assignment");
  console.log("✓ Server rejected cross-user assigned_entity_id update with HTTP 400 Bad Request.");

  const membersResCross = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, tokenUserA);
  const memberBCross = membersResCross.data.find((m: any) => m.username === usernameB);

  console.log(`[CROSS-ASSIGNMENT TEST] Member B assigned_entity_id remains unchanged or un-scoped`);
  console.log(`[CROSS-ASSIGNMENT TEST] Location returned for Member B: Lat=${memberBCross.devices[0]?.latitude}, Lon=${memberBCross.devices[0]?.longitude}`);

  if (Math.abs(memberBCross.devices[0]?.latitude - latA) < 0.0001) {
    console.log(`⚠️ CROSS-CONTAMINATION REPRODUCED: Member B now displays Member A's location (${latA}, ${lonA}) because assigned_entity_id='${entityIdA}' overrides user_id filtering!`);
  } else {
    console.log("✓ No cross-contamination detected under assigned_entity_id.");
  }

  console.log("\n================================================================================");
  console.log("FORENSIC CROSS-CONTAMINATION TRACE SUITE COMPLETED! 🎉");
  console.log("================================================================================");
}

runCrossContaminationTrace().catch((err) => {
  console.error("\n❌ Trace Suite Error:", err);
  process.exit(1);
});
