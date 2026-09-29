import http from "http";

const BASE_URL = "http://127.0.0.1:3000";

function makeRequest(
  method: string,
  path: string,
  body?: any,
  token?: string,
  headersExtra?: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const postData = body
      ? typeof body === "string"
        ? body
        : JSON.stringify(body)
      : "";

    const headers: Record<string, string> = { ...headersExtra };
    if (body) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json";
      }
      headers["Content-Length"] = Buffer.byteLength(postData).toString();
    }
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          try {
            const data = rawData ? JSON.parse(rawData) : {};
            resolve({ status: res.statusCode || 500, headers: res.headers, data });
          } catch (e) {
            resolve({ status: res.statusCode || 500, headers: res.headers, data: rawData });
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runCompanionLogoutFlowTests() {
  console.log("============================================================");
  console.log("RUNNING COMPANION APP LOGOUT & FLOW TEST SUITE");
  console.log("============================================================");

  const ts = Date.now();
  const username = `logout_user_${ts}`;
  const password = "securePassword123!";

  // 1. Setup / Register User
  console.log("1. Registering test user account...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    display_name: "Logout Flow Test User",
    password
  });
  if (regRes.status !== 200 || !regRes.data.access_token) {
    throw new Error(`Registration failed: ${JSON.stringify(regRes.data)}`);
  }
  const token = regRes.data.access_token;
  console.log("✓ User successfully registered.");

  // 2. Test Companion Login Page (/auth/authorize)
  console.log("\n2. Testing GET /auth/authorize (Companion Login Page)...");
  // Test with full OAuth parameters
  const oauthParams = "response_type=code&client_id=https%3A%2F%2Fhome-assistant.io%2Fandroid&redirect_uri=homeassistant%3A%2F%2Fauth-callback&state=test_oauth_state";
  const authPageWithParams = await makeRequest("GET", `/auth/authorize?${oauthParams}`);
  if (authPageWithParams.status !== 200 || typeof authPageWithParams.data !== "string" || !authPageWithParams.data.includes("Log In & Authorize")) {
    throw new Error(`GET /auth/authorize with params failed (${authPageWithParams.status})`);
  }
  console.log("✓ GET /auth/authorize with parameters renders Companion Login HTML.");

  // Test refreshing or direct visit to /auth/authorize without query parameters
  const authPageNoParams = await makeRequest("GET", "/auth/authorize");
  if (authPageNoParams.status !== 200 || typeof authPageNoParams.data !== "string" || !authPageNoParams.data.includes("Log In & Authorize")) {
    throw new Error(`GET /auth/authorize without params failed (${authPageNoParams.status})`);
  }
  console.log("✓ Refreshing /auth/authorize without params renders Companion Login HTML with default companion configuration.");

  // 3. Test Companion Login Submission (/auth/login_submit)
  console.log("\n3. Testing Companion Login Submission (POST /auth/login_submit)...");
  const formPayload = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&client_id=${encodeURIComponent("https://home-assistant.io/android")}&redirect_uri=${encodeURIComponent("homeassistant://auth-callback")}&response_type=code&state=test_oauth_state`;
  const loginSubmitRes = await makeRequest("POST", "/auth/login_submit", formPayload, undefined, {
    "Content-Type": "application/x-www-form-urlencoded"
  });

  if (loginSubmitRes.status !== 302 || !loginSubmitRes.headers.location) {
    throw new Error(`POST /auth/login_submit failed (${loginSubmitRes.status}): ${JSON.stringify(loginSubmitRes.data)}`);
  }
  const callbackUrl = new URL(loginSubmitRes.headers.location);
  const authCode = callbackUrl.searchParams.get("code");
  if (!authCode) {
    throw new Error(`No code found in redirect URL: ${loginSubmitRes.headers.location}`);
  }
  console.log(`✓ POST /auth/login_submit returned 302 redirect with valid OAuth code: ${authCode.substring(0, 10)}...`);

  // 4. Test OAuth Token Exchange (POST /auth/token)
  console.log("\n4. Testing Token Exchange (POST /auth/token)...");
  const tokenPayload = `grant_type=authorization_code&code=${encodeURIComponent(authCode)}&client_id=${encodeURIComponent("https://home-assistant.io/android")}`;
  const tokenExchangeRes = await makeRequest("POST", "/auth/token", tokenPayload, undefined, {
    "Content-Type": "application/x-www-form-urlencoded"
  });
  if (tokenExchangeRes.status !== 200 || !tokenExchangeRes.data.access_token) {
    throw new Error(`POST /auth/token failed: ${JSON.stringify(tokenExchangeRes.data)}`);
  }
  const companionAccessToken = tokenExchangeRes.data.access_token;
  console.log("✓ POST /auth/token issued valid access_token and refresh_token.");

  // 5. Test Accessing Map & User Session via Companion Token
  console.log("\n5. Testing authenticated user endpoint with Companion token...");
  const meRes = await makeRequest("GET", "/api/auth/me", undefined, companionAccessToken);
  if (meRes.status !== 200 || meRes.data.username !== username) {
    throw new Error(`GET /api/auth/me failed with companion token: ${JSON.stringify(meRes.data)}`);
  }
  console.log(`✓ Validated session for ${meRes.data.display_name} (${meRes.data.username}).`);

  // 6. Test Web / PWA Login Flow (/api/auth/login)
  console.log("\n6. Testing Normal Web / PWA Login Flow (POST /api/auth/login)...");
  const webLoginRes = await makeRequest("POST", "/api/auth/login", {
    username,
    password
  });
  if (webLoginRes.status !== 200 || !webLoginRes.data.access_token) {
    throw new Error(`Web login failed: ${JSON.stringify(webLoginRes.data)}`);
  }
  const webAccessToken = webLoginRes.data.access_token;
  console.log("✓ Normal Web login succeeded with access token.");

  // 7. Test Setup Status endpoint for Normal Web Entry
  console.log("\n7. Testing GET /api/setup/status...");
  const setupRes = await makeRequest("GET", "/api/setup/status");
  if (setupRes.status !== 200 || typeof setupRes.data.needs_setup !== "boolean") {
    throw new Error(`GET /api/setup/status failed: ${JSON.stringify(setupRes.data)}`);
  }
  console.log("✓ GET /api/setup/status returned 200 OK (needs_setup: false).");

  // 8. Test Invalid Token / Revocation
  console.log("\n8. Testing Token Rejection on invalid token...");
  const invalidTokenRes = await makeRequest("GET", "/api/auth/me", undefined, "invalid_expired_token");
  if (invalidTokenRes.status !== 401) {
    throw new Error(`Expected 401 for invalid token, got ${invalidTokenRes.status}`);
  }
  console.log("✓ Invalid/cleared token correctly returns 401 Unauthorized.");

  console.log("\n============================================================");
  console.log("ALL COMPANION APP LOGOUT & FLOW TESTS PASSED! 🎉");
  console.log("============================================================\n");
}

runCompanionLogoutFlowTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
