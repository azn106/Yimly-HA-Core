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

async function runOwnershipTestSuite() {
  console.log("================================================================================");
  console.log("RUNNING DEVICE ASSIGNMENT & LOCATION OWNERSHIP REGRESSION SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();

  // ALEXIS (User with linked device)
  const usernameAlexis = `alexis_${timestamp}`;
  const passwordAlexis = "AlexisPass123!";
  const nameAlexis = "Alexis";
  const latAlexis = 37.774929;
  const lonAlexis = -122.419416;

  // AMANDA (User / unlinked member to test cross assignment)
  const usernameAmanda = `amanda_${timestamp}`;
  const passwordAmanda = "AmandaPass123!";
  const nameAmanda = "Amanda";

  // 1. REGISTER ALEXIS
  console.log("\n[TEST 1] Registering Alexis...");
  const regAlexis = await makeRequest("POST", "/api/auth/register", {
    username: usernameAlexis,
    password: passwordAlexis,
    display_name: nameAlexis
  });
  assert(regAlexis.status === 200, "Alexis registration failed");
  const tokenAlexis = regAlexis.data.access_token;
  const userAlexis = regAlexis.data.user;

  // 2. INGEST TRACCAR TELEMETRY FOR ALEXIS (CREATING ENTITY STATE OWNED BY ALEXIS)
  console.log("\n[TEST 2] Fetching Alexis's Traccar config & Ingesting coordinates...");
  const cfgAlexis = await makeRequest("GET", "/api/traccar/config", undefined, tokenAlexis);
  assert(cfgAlexis.status === 200, "Alexis config failed");
  const traccarTokenAlexis = cfgAlexis.data.token;
  const entityIdAlexis = `device_tracker.${usernameAlexis.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;

  const postAlexis = await makeRequest(
    "POST",
    `/api/traccar/${traccarTokenAlexis}`,
    {
      id: usernameAlexis,
      lat: latAlexis.toString(),
      lon: lonAlexis.toString(),
      timestamp: Math.floor(Date.now() / 1000).toString(),
      batt: "95"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(postAlexis.status === 200, "Alexis Traccar ingestion failed");

  // 3. REGISTER AMANDA & GET TOKEN (Used to perform actions)
  console.log("\n[TEST 3] Registering Amanda...");
  const regAmanda = await makeRequest("POST", "/api/auth/register", {
    username: usernameAmanda,
    password: passwordAmanda,
    display_name: nameAmanda
  });
  assert(regAmanda.status === 200, "Amanda registration failed");
  const tokenAmanda = regAmanda.data.access_token;

  // 4. AMANDA JOINS ALEXIS'S FAMILY CIRCLE
  console.log("\n[TEST 4] Amanda joins Alexis's family circle...");
  const circlesAlexis = await makeRequest("GET", "/api/circles", undefined, tokenAlexis);
  const circleId = circlesAlexis.data[0].id;
  const inviteCode = circlesAlexis.data[0].invite_code;

  const joinAmanda = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, tokenAmanda);
  assert(joinAmanda.status === 200, "Amanda join circle failed");

  // 5. TEST GET /api/devices/available FOR ALEXIS AND AMANDA
  console.log("\n[TEST 5] Testing available devices listing...");
  const avAlexis = await makeRequest("GET", "/api/devices/available", undefined, tokenAlexis);
  assert(avAlexis.status === 200, "Available devices Alexis failed");
  const hasAlexisDevice = avAlexis.data.some((d: any) => d.entity_id === entityIdAlexis);
  assert(hasAlexisDevice === true, "Alexis must see her own device in available list");

  const avAmanda = await makeRequest("GET", "/api/devices/available", undefined, tokenAmanda);
  assert(avAmanda.status === 200, "Available devices Amanda failed");
  const seeAlexisDevice = avAmanda.data.some((d: any) => d.entity_id === entityIdAlexis);
  assert(seeAlexisDevice === false, "Amanda must NOT see Alexis's private device in available list");
  console.log("✓ Alexis's device remains private. It does not appear in Amanda's available list.");

  // 6. AMANDA TRIES TO CREATE AN UNLINKED MEMBER WITH ALEXIS'S ENTITY
  console.log("\n[TEST 6] Amanda attempts to create an unlinked member assigned to Alexis's device...");
  const createRes = await makeRequest(
    "POST",
    `/api/circles/${circleId}/members`,
    {
      display_name: "Unlinked Amanda Clone",
      assigned_entity_id: entityIdAlexis
    },
    tokenAmanda
  );
  assert(createRes.status === 400, "Expected HTTP 400 when creating member with cross-user assigned_entity_id");
  console.log("✓ Server rejected creation of unlinked member assigned to Alexis's private device.");

  // 7. AMANDA CREATES A LEGITIMATE UNLINKED MEMBER WITHOUT DEVICES
  console.log("\n[TEST 7] Amanda creates a legitimate unlinked member without devices...");
  const legitCreateRes = await makeRequest(
    "POST",
    `/api/circles/${circleId}/members`,
    {
      display_name: "Legit Amanda Friend"
    },
    tokenAmanda
  );
  if (legitCreateRes.status !== 200 && legitCreateRes.status !== 201) {
    console.error("legitCreateRes Failed:", legitCreateRes.status, legitCreateRes.data);
  }
  assert(legitCreateRes.status === 200 || legitCreateRes.status === 201, "Creation of unlinked member failed");
  const unlinkedMemberId = legitCreateRes.data.id;

  // 8. AMANDA TRIES TO UPDATE THE UNLINKED MEMBER WITH ALEXIS'S ENTITY
  console.log("\n[TEST 8] Amanda attempts to update unlinked member to Alexis's device...");
  const updateRes = await makeRequest(
    "PUT",
    `/api/circles/${circleId}/members/${unlinkedMemberId}`,
    {
      assigned_entity_id: entityIdAlexis
    },
    tokenAmanda
  );
  assert(updateRes.status === 400, "Expected HTTP 400 when updating member to cross-user assigned_entity_id");
  console.log("✓ Server rejected update of unlinked member to Alexis's private device.");

  // 9. VERIFY READ ENDPOINT DOES NOT RESOLVE COORDINATES OF OTHER USERS FOR UNLINKED MEMBER
  console.log("\n[TEST 9] Verifying GET /api/circles/:id/members does not leak Alexis's location...");
  const membersRes = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, tokenAlexis);
  assert(membersRes.status === 200, "Circle members query failed");

  const unlinkedMemberObj = membersRes.data.find((m: any) => m.id === unlinkedMemberId);
  assert(unlinkedMemberObj.devices.length === 0, "Unlinked member must not have devices/locations returned from another user");
  console.log("✓ Amanda's unlinked member does not leak any coordinates.");

  console.log("\n================================================================================");
  console.log("DEVICE OWNERSHIP AND DISCOVERY REGRESSION SUITE PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runOwnershipTestSuite().catch((err) => {
  console.error("\n❌ Regression Suite Failed:", err);
  process.exit(1);
});
