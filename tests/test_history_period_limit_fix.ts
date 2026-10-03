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
          } catch {
            // raw text
          }
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

async function runHistoryPeriodLimitTest() {
  console.log("================================================================================");
  console.log("RUNNING LOCATION HISTORY PERIOD UNTRUNCATED RETRIEVAL REGRESSION SUITE");
  console.log("================================================================================");

  const timestamp = Date.now();
  const username = `hist_limit_user_${timestamp}`;
  const password = "LimitPassword123!";

  // 1. Register user
  console.log("\n[TEST 1] Registering test user account...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: "History Limit Test User"
  });
  assert(regRes.status === 200, `Registration failed: ${JSON.stringify(regRes.data)}`);
  const token = regRes.data.access_token;
  assert(Boolean(token), "Missing token");
  console.log(`✓ User '${username}' registered.`);

  // 2. Fetch Traccar config
  console.log("\n[TEST 2] Fetching Traccar Client configuration...");
  const configRes = await makeRequest("GET", "/api/traccar/config", undefined, token);
  assert(configRes.status === 200, "Failed to fetch Traccar config");
  const traccarToken = configRes.data.token;
  console.log(`✓ Configured with token: ${traccarToken}`);

  // 3. Post 250 telemetry fixes spread over 5 days (120 hours)
  console.log("\n[TEST 3] Ingesting 250 historical location points over 5 days...");
  const nowEpoch = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 250; i++) {
    // Points spread across last 120 hours (5 days)
    const fixEpoch = nowEpoch - Math.floor(120 * 3600 * (249 - i) / 249);
    const lat = 37.7749 + (i * 0.0001);
    const lon = -122.4194 + (i * 0.0001);

    const postRes = await makeRequest(
      "POST",
      `/api/traccar/${traccarToken}`,
      {
        id: username,
        lat: lat.toString(),
        lon: lon.toString(),
        timestamp: fixEpoch.toString(),
        batt: "95"
      },
      undefined,
      { "Content-Type": "application/x-www-form-urlencoded" }
    );
    assert(postRes.status === 200, `Telemetry post ${i} failed`);
  }
  console.log("✓ Ingested 250 points into location_history.");

  // 4. Query 1-Week History (hours=168)
  console.log("\n[TEST 4] Querying /api/history/period?hours=168 (1 Week)...");
  const histWeekRes = await makeRequest("GET", "/api/history/period?hours=168", undefined, token);
  assert(histWeekRes.status === 200 && Array.isArray(histWeekRes.data), "History query failed");
  const weekCount = histWeekRes.data.length;
  console.log(`✓ 1-Week query returned ${weekCount} items.`);
  assert(weekCount === 250, `Expected all 250 records without truncation, got ${weekCount}`);

  // 5. Query 1-Month History (hours=720)
  console.log("\n[TEST 5] Querying /api/history/period?hours=720 (1 Month)...");
  const histMonthRes = await makeRequest("GET", "/api/history/period?hours=720", undefined, token);
  assert(histMonthRes.status === 200 && Array.isArray(histMonthRes.data), "History query failed");
  const monthCount = histMonthRes.data.length;
  console.log(`✓ 1-Month query returned ${monthCount} items.`);
  assert(monthCount === 250, `Expected all 250 records without truncation, got ${monthCount}`);

  console.log("\n================================================================================");
  console.log("LOCATION HISTORY UNTRUNCATED RETRIEVAL REGRESSION SUITE PASSED! 🎉");
  console.log("================================================================================");
}

runHistoryPeriodLimitTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
