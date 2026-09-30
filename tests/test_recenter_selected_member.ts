import http from "http";

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
): Promise<{ status: number; data: any }> {
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
          resolve({ status: res.statusCode || 0, data: parsed });
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

async function runRecenterSelectedMemberTestSuite() {
  console.log("================================================================================");
  console.log("RUNNING RECENTER SELECTED MEMBER FEATURE TEST SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();
  const username = `recenter_user_${timestamp}`;
  const password = "RecenterPass123!";

  // 1. Register User & Traccar Device
  console.log("\n[TEST 1] Registering Yimly user and verifying Traccar device...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: "Recenter Member Test"
  });
  assert(regRes.status === 200, "Registration failed");
  const userToken = regRes.data.access_token;

  const configRes = await makeRequest("GET", "/api/traccar/config", undefined, userToken);
  assert(configRes.status === 200, "Traccar config failed");
  const traccarToken = configRes.data.token;

  // 2. Member without coordinates initially
  console.log("\n[TEST 2] Verifying initial member state before location fix (coordinates are null)...");
  const circlesRes = await makeRequest("GET", "/api/circles", undefined, userToken);
  const circleId = circlesRes.data[0].id;
  const membersRes1 = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, userToken);
  const member1 = membersRes1.data.find((m: any) => m.username === username);
  assert(Boolean(member1), "Member not found in circle");
  const initialDevice = member1.devices?.[0];
  assert(!initialDevice || initialDevice.latitude === null, "Initial latitude should be null before telemetry");
  console.log("✓ Member has no valid coordinates initially (Recenter action remains safely no-op/disabled).");

  // 3. Post Traccar Location Telemetry
  console.log("\n[TEST 3] Ingesting valid Traccar GPS telemetry for member...");
  const targetLat = 37.779200;
  const targetLon = -122.418300;
  const traccarPostRes = await makeRequest(
    "POST",
    `/api/traccar/${traccarToken}`,
    {
      id: username,
      lat: targetLat.toString(),
      lon: targetLon.toString(),
      timestamp: Math.floor(Date.now() / 1000).toString(),
      batt: "92"
    },
    undefined,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  assert(traccarPostRes.status === 200, "Traccar telemetry post failed");
  console.log("✓ Traccar location telemetry received and stored.");

  // 4. Verify Member Endpoint Returns Updated Location
  console.log("\n[TEST 4] Verifying selected member location coordinates are available for Recenter action...");
  const membersRes2 = await makeRequest("GET", `/api/circles/${circleId}/members`, undefined, userToken);
  const member2 = membersRes2.data.find((m: any) => m.username === username);
  const activeDevice = member2.devices?.[0];
  assert(Boolean(activeDevice), "Active device missing");
  assert(Math.abs(activeDevice.latitude - targetLat) < 0.0001, `Lat mismatch: ${activeDevice.latitude}`);
  assert(Math.abs(activeDevice.longitude - targetLon) < 0.0001, `Lon mismatch: ${activeDevice.longitude}`);
  console.log(`✓ Selected member current location confirmed at lat=${activeDevice.latitude}, lon=${activeDevice.longitude}.`);

  console.log("\n================================================================================");
  console.log("RECENTER SELECTED MEMBER FEATURE TEST SUITE PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runRecenterSelectedMemberTestSuite().catch((err) => {
  console.error("\n❌ Test Suite Failed:", err);
  process.exit(1);
});
