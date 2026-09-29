import http from "http";
import WebSocket from "ws";

const BASE_URL = "http://127.0.0.1:3000";
const WS_URL = "ws://127.0.0.1:3000/api/websocket";

async function makeRequest(
  method: string,
  pathStr: string,
  body?: any,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, BASE_URL);
    const headers: Record<string, string> = {
      ...extraHeaders
    };
    if (body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
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
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 500, data: parsed, headers: res.headers });
        });
      }
    );

    req.on("error", reject);
    if (body) {
      if (typeof body === "string") {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

async function runPostRegistrationTestSuite() {
  console.log("============================================================");
  console.log("RUNNING POST-REGISTRATION COMPANION APP TEST SUITE");
  console.log("============================================================\n");

  const testId = Date.now();
  const username = `postreg_user_${testId}`;
  const password = "Password123!";
  const displayName = "PostReg Test User";

  // 1. Setup / Register User
  console.log("1. Setting up authenticated user...");
  const regRes = await makeRequest("POST", "/api/auth/register", {
    username,
    password,
    display_name: displayName
  });
  if (regRes.status !== 200 && regRes.status !== 201) {
    throw new Error(`Failed to register user: ${JSON.stringify(regRes.data)}`);
  }
  const token = regRes.data.access_token;
  console.log("✓ User registered and access token obtained.");

  // 2. Test GET /?external_auth=1
  console.log("\n2. Testing GET /?external_auth=1 (Frontend loading)...");
  const frontendRes = await makeRequest("GET", "/?external_auth=1");
  if (frontendRes.status !== 200) {
    throw new Error(`GET /?external_auth=1 returned status ${frontendRes.status}`);
  }
  const contentType = (frontendRes.headers["content-type"] as string) || "";
  console.log(`✓ GET /?external_auth=1 returned 200 OK (Content-Type: ${contentType}).`);

  // 3. Test GET /api/discovery_info
  console.log("\n3. Testing GET /api/discovery_info...");
  const discoveryRes = await makeRequest("GET", "/api/discovery_info");
  if (discoveryRes.status !== 200) {
    throw new Error(`GET /api/discovery_info failed (${discoveryRes.status}): ${JSON.stringify(discoveryRes.data)}`);
  }
  if (!discoveryRes.data.version || !discoveryRes.data.location_name) {
    throw new Error(`Invalid discovery_info response format: ${JSON.stringify(discoveryRes.data)}`);
  }
  console.log("✓ GET /api/discovery_info returned 200 OK with valid Home Assistant metadata.");

  // 4. Test GET /api/services
  console.log("\n4. Testing GET /api/services...");
  const servicesRes = await makeRequest("GET", "/api/services", undefined, token);
  if (servicesRes.status !== 200) {
    throw new Error(`GET /api/services failed (${servicesRes.status}): ${JSON.stringify(servicesRes.data)}`);
  }
  if (!Array.isArray(servicesRes.data)) {
    throw new Error(`Expected array for /api/services, got: ${typeof servicesRes.data}`);
  }
  console.log(`✓ GET /api/services returned 200 OK (${servicesRes.data.length} service domains).`);

  // 5. Test WebSocket Connection and Full Startup Sequence
  console.log("\n5. Testing WebSocket connection and Home Assistant handshake...");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let step = 0;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket handshake / command sequence timed out"));
    }, 8000);

    ws.on("open", () => {
      console.log("  → WebSocket connection established.");
    });

    ws.on("message", (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString());

      if (step === 0) {
        // Expect auth_required
        if (msg.type !== "auth_required") {
          clearTimeout(timeout);
          return reject(new Error(`Expected auth_required, received: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'auth_required' challenge.");
        step = 1;
        // Send auth
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (step === 1) {
        // Expect auth_ok
        if (msg.type !== "auth_ok") {
          clearTimeout(timeout);
          return reject(new Error(`Expected auth_ok, received: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'auth_ok'.");
        step = 2;
        // Send auth/current_user (Home Assistant standard initial command)
        ws.send(JSON.stringify({ id: 1, type: "auth/current_user" }));
      } else if (step === 2) {
        if (msg.id !== 1 || !msg.success || !msg.result || !msg.result.id || !msg.result.name) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid auth/current_user response: ${JSON.stringify(msg)}`));
        }
        // Verify no sensitive keys leaked
        const rawJson = JSON.stringify(msg.result);
        if (rawJson.includes("password") || rawJson.includes("token") || rawJson.includes("secret")) {
          clearTimeout(timeout);
          return reject(new Error(`auth/current_user exposed sensitive data: ${rawJson}`));
        }
        console.log(`  ✓ Received 'auth/current_user' result (User: ${msg.result.name}, ID: ${msg.result.id}, is_owner: ${msg.result.is_owner}).`);
        step = 3;
        // Send config/device_registry/list
        ws.send(JSON.stringify({ id: 2, type: "config/device_registry/list" }));
      } else if (step === 3) {
        if (msg.id !== 2 || !msg.success || !Array.isArray(msg.result)) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid config/device_registry/list response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'config/device_registry/list' result.");
        step = 4;
        // Send config/entity_registry/list
        ws.send(JSON.stringify({ id: 3, type: "config/entity_registry/list" }));
      } else if (step === 4) {
        if (msg.id !== 3 || !msg.success || !Array.isArray(msg.result)) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid config/entity_registry/list response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'config/entity_registry/list' result.");
        step = 5;
        // Send config/area_registry/list
        ws.send(JSON.stringify({ id: 4, type: "config/area_registry/list" }));
      } else if (step === 5) {
        if (msg.id !== 4 || !msg.success || !Array.isArray(msg.result)) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid config/area_registry/list response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'config/area_registry/list' result.");
        step = 6;
        // Send frontend/get_user_data
        ws.send(JSON.stringify({ id: 5, type: "frontend/get_user_data" }));
      } else if (step === 6) {
        if (msg.id !== 5 || !msg.success) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid frontend/get_user_data response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'frontend/get_user_data' result.");
        step = 7;
        // Send get_config
        ws.send(JSON.stringify({ id: 6, type: "get_config" }));
      } else if (step === 7) {
        if (msg.id !== 6 || !msg.success || !msg.result?.components) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid get_config response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'get_config' result.");
        step = 8;
        // Send get_states
        ws.send(JSON.stringify({ id: 7, type: "get_states" }));
      } else if (step === 8) {
        if (msg.id !== 7 || !msg.success || !Array.isArray(msg.result)) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid get_states response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'get_states' result.");
        step = 9;
        // Send subscribe_events
        ws.send(JSON.stringify({ id: 8, type: "subscribe_events", event_type: "state_changed" }));
      } else if (step === 9) {
        if (msg.id !== 8 || !msg.success) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid subscribe_events response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'subscribe_events' result.");
        step = 10;
        // Send supported_features (coalesce_messages)
        ws.send(JSON.stringify({ id: 9, type: "supported_features", features: { coalesce_messages: 1 } }));
      } else if (step === 10) {
        if (msg.id !== 9 || !msg.success) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid supported_features response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'supported_features' result.");
        step = 11;
        // Send ping with id
        ws.send(JSON.stringify({ id: 10, type: "ping" }));
      } else if (step === 11) {
        if (msg.id !== 10 || msg.type !== "pong") {
          clearTimeout(timeout);
          return reject(new Error(`Invalid ping response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'pong' for ping with id.");
        step = 12;
        // Send get_services
        ws.send(JSON.stringify({ id: 11, type: "get_services" }));
      } else if (step === 12) {
        if (msg.id !== 11 || !msg.success) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid get_services response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'get_services' result.");
        step = 13;
        // Send get_panels
        ws.send(JSON.stringify({ id: 12, type: "get_panels" }));
      } else if (step === 13) {
        if (msg.id !== 12 || !msg.success || !msg.result?.lovelace) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid get_panels response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'get_panels' result.");
        step = 14;
        // Send frontend/get_translations
        ws.send(JSON.stringify({ id: 13, type: "frontend/get_translations" }));
      } else if (step === 14) {
        if (msg.id !== 13 || !msg.success) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid frontend/get_translations response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'frontend/get_translations' result.");
        step = 15;
        // Send manifest/list
        ws.send(JSON.stringify({ id: 14, type: "manifest/list" }));
      } else if (step === 15) {
        if (msg.id !== 14 || !msg.success || !Array.isArray(msg.result)) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid manifest/list response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'manifest/list' result.");
        step = 16;
        // Send unsubscribe_events
        ws.send(JSON.stringify({ id: 15, type: "unsubscribe_events", subscription: 8 }));
      } else if (step === 16) {
        if (msg.id !== 15 || !msg.success) {
          clearTimeout(timeout);
          return reject(new Error(`Invalid unsubscribe_events response: ${JSON.stringify(msg)}`));
        }
        console.log("  ✓ Received 'unsubscribe_events' result.");
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // 6. Test External Auth token validation with /api/auth/me
  console.log("\n6. Testing token validation against /api/auth/me...");
  const meRes = await makeRequest("GET", "/api/auth/me", undefined, token);
  if (meRes.status !== 200) {
    throw new Error(`/api/auth/me failed with status ${meRes.status}`);
  }
  if (meRes.data.username !== username) {
    throw new Error(`Expected username ${username}, got ${meRes.data.username}`);
  }
  console.log(`✓ Token validated successfully for user: ${meRes.data.username}`);

  // 7. Test Multiple Simultaneous WebSocket Connections (e.g. Companion App Webview + Native Background Service)
  console.log("\n7. Testing multiple simultaneous WebSocket connections for same user...");
  await new Promise<void>((resolve, reject) => {
    const ws1 = new WebSocket(WS_URL);
    const ws2 = new WebSocket(WS_URL);
    let ws1Ready = false;
    let ws2Ready = false;

    const timeout = setTimeout(() => {
      ws1.close();
      ws2.close();
      reject(new Error("Multi-connection test timed out"));
    }, 6000);

    const checkBothReady = () => {
      if (ws1Ready && ws2Ready) {
        clearTimeout(timeout);
        ws1.close();
        ws2.close();
        console.log("  ✓ Both concurrent WebSocket sessions authenticated and responded independently.");
        resolve();
      }
    };

    ws1.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_required") {
        ws1.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_ok") {
        ws1.send(JSON.stringify({ id: 101, type: "auth/current_user" }));
      } else if (msg.id === 101 && msg.success) {
        ws1Ready = true;
        checkBothReady();
      }
    });

    ws2.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_required") {
        ws2.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_ok") {
        ws2.send(JSON.stringify({ id: 201, type: "auth/current_user" }));
      } else if (msg.id === 201 && msg.success) {
        ws2Ready = true;
        checkBothReady();
      }
    });

    ws1.on("error", (err) => { clearTimeout(timeout); reject(err); });
    ws2.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });

  console.log("\n============================================================");
  console.log("ALL POST-REGISTRATION COMPANION APP TESTS PASSED! 🎉");
  console.log("============================================================\n");
}

runPostRegistrationTestSuite().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
