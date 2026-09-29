import http from "http";
import crypto from "crypto";

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

// Haversine formula for coordinate calculation
function getCoordsAtDistance(lat: number, lon: number, meters: number): { latitude: number; longitude: number } {
  // Rough estimate: 1 degree latitude ~ 111,000 meters
  const deltaLat = meters / 111000;
  return {
    latitude: lat + deltaLat,
    longitude: lon
  };
}

async function runGeofenceTests() {
  console.log("Starting Geofence Arrival/Departure Engine Test Suite...");

  // 1. Authenticate User 1 (Admin)
  const login1 = await makeRequest("POST", "/api/auth/login", {
    username: "admin@yimly.home",
    password: "password"
  });
  if (login1.status !== 200) {
    throw new Error(`Login failed for user 1: ${JSON.stringify(login1.data)}`);
  }
  const token1 = login1.data.access_token;
  const user1Id = login1.data.user.id;
  console.log("✓ User 1 authenticated successfully");

  // 2. Register and Authenticate User 2
  const user2Name = `u2_geo_test_${Date.now()}`;
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

  // 3. Create Circle One (User 1 is owner)
  const circle1Res = await makeRequest("POST", "/api/circles", { name: "Geo Circle" }, token1);
  const circleId = circle1Res.data.id;
  const inviteCode = circle1Res.data.invite_code;
  console.log(`✓ Circle created (ID: ${circleId})`);

  // 4. User 2 joins Circle
  const joinRes = await makeRequest("POST", "/api/circles/join", { invite_code: inviteCode }, token2);
  if (joinRes.status !== 200) {
    throw new Error("User 2 failed to join Circle");
  }
  console.log("✓ User 2 joined Circle");

  // 5. Create Place: Home (radius 100m, coordinates 37.7749, -122.4194)
  const homeRes = await makeRequest(
    "POST",
    `/api/circles/${circleId}/places`,
    {
      name: "Home Base",
      latitude: 37.7749,
      longitude: -122.4194,
      radius: 100,
      address: "123 Main St"
    },
    token1
  );
  if (homeRes.status < 200 || homeRes.status >= 300) {
    throw new Error(`Failed to create Home place: ${JSON.stringify(homeRes.data)}`);
  }
  const homePlaceId = homeRes.data.id;
  console.log(`✓ Place 'Home Base' created (ID: ${homePlaceId})`);

  // Create Place: Work (radius 150m, coordinates 37.7891, -122.4014)
  const workRes = await makeRequest(
    "POST",
    `/api/circles/${circleId}/places`,
    {
      name: "Office Work",
      latitude: 37.7891,
      longitude: -122.4014,
      radius: 150,
      address: "456 Market St"
    },
    token1
  );
  if (workRes.status < 200 || workRes.status >= 300) {
    throw new Error(`Failed to create Work place: ${JSON.stringify(workRes.data)}`);
  }
  const workPlaceId = workRes.data.id;
  console.log(`✓ Place 'Office Work' created (ID: ${workPlaceId})`);

  // SCENARIO 1: First location sample does NOT create arrival alert
  // Target: far outside Home (e.g. 500 meters away)
  const outsideCoords = getCoordsAtDistance(37.7749, -122.4194, 500);
  const telemetry1 = await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: outsideCoords.latitude,
      longitude: outsideCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 88,
      gps_accuracy: 10
    },
    token2
  );
  if (telemetry1.status !== 200) {
    throw new Error(`Telemetry failed: ${JSON.stringify(telemetry1.data)}`);
  }
  console.log("Telemetry 1 diagnostics:", JSON.stringify(telemetry1.data.diagnostics, null, 2));

  // Verify User 1 (Admin) has no alerts (starts at 0)
  const alerts1 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alerts1.data.length !== 0) {
    throw new Error(`Expected 0 alerts on initial sample, got ${alerts1.data.length}`);
  }
  console.log("✓ Scenario 1: First location sample does not create arrival alert (Passed)");

  // SCENARIO 2: Outside -> Inside transition creates arrival alert
  // Move User 2 inside Home Base (e.g. 10 meters away from center)
  const insideCoords = getCoordsAtDistance(37.7749, -122.4194, 10);
  const telemetry2 = await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: insideCoords.latitude,
      longitude: insideCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 87,
      gps_accuracy: 10
    },
    token2
  );
  console.log("Telemetry 2 diagnostics:", JSON.stringify(telemetry2.data.diagnostics, null, 2));

  // Verify User 1 receives an arrival alert
  const alerts2 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alerts2.data.length !== 1 || alerts2.data[0].alert_type !== "arrival") {
    throw new Error(`Expected exactly 1 arrival alert, got: ${JSON.stringify(alerts2.data)}`);
  }
  const alertArrival = alerts2.data[0];
  if (!alertArrival.title.includes("User Two") || !alertArrival.title.includes("Home Base")) {
    throw new Error(`Alert title incorrect: ${alertArrival.title}`);
  }
  console.log("✓ Scenario 2: Outside -> Inside transition creates arrival alert (Passed)");

  // SCENARIO 3: Inside -> Inside creates no duplicate alert
  const insideCoords2 = getCoordsAtDistance(37.7749, -122.4194, 15);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: insideCoords2.latitude,
      longitude: insideCoords2.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 86,
      gps_accuracy: 10
    },
    token2
  );

  const alerts3 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alerts3.data.length !== 1) {
    throw new Error(`Expected alert count to remain 1, got: ${alerts3.data.length}`);
  }
  console.log("✓ Scenario 3: Inside -> Inside creates no duplicate alert (Passed)");

  // SCENARIO 4: GPS boundary jitter / hysteresis handling (stays inside inside hysteresis buffer)
  // Radius is 100m. 110m distance is outside radius but within 20m hysteresis buffer (limit is 120m)
  const boundaryJitterCoords = getCoordsAtDistance(37.7749, -122.4194, 110);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: boundaryJitterCoords.latitude,
      longitude: boundaryJitterCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 85,
      gps_accuracy: 10
    },
    token2
  );

  const alertsJitter = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsJitter.data.length !== 1) {
    throw new Error(`Expected alert count to stay 1 due to hysteresis, got: ${alertsJitter.data.length}`);
  }
  console.log("✓ Scenario 4: GPS boundary jitter handling suppresses premature departures (Passed)");

  // SCENARIO 5: Inside -> Outside creates departure alert (past hysteresis threshold)
  // Move User 2 past hysteresis buffer (e.g. 150 meters away from center)
  const outsidePastHysteresis = getCoordsAtDistance(37.7749, -122.4194, 150);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: outsidePastHysteresis.latitude,
      longitude: outsidePastHysteresis.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 84,
      gps_accuracy: 10
    },
    token2
  );

  const alertsDeparture = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsDeparture.data.length !== 2 || alertsDeparture.data[0].alert_type !== "departure") {
    throw new Error(`Expected 2 alerts with the latest being 'departure', got: ${JSON.stringify(alertsDeparture.data)}`);
  }
  console.log("✓ Scenario 5: Inside -> Outside creates departure alert past hysteresis (Passed)");

  // SCENARIO 6: Outside -> Outside creates no duplicate alert
  const outsidePastHysteresis2 = getCoordsAtDistance(37.7749, -122.4194, 200);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: outsidePastHysteresis2.latitude,
      longitude: outsidePastHysteresis2.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 83,
      gps_accuracy: 10
    },
    token2
  );

  const alertsOutside2 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsOutside2.data.length !== 2) {
    throw new Error(`Expected alert count to stay 2, got: ${alertsOutside2.data.length}`);
  }
  console.log("✓ Scenario 6: Outside -> Outside creates no duplicate alert (Passed)");

  // SCENARIO 7: Multiple Places maintain independent state
  // Move User 2 inside Office Work (radius 150m, coordinate 37.7891, -122.4014)
  const insideWorkCoords = getCoordsAtDistance(37.7891, -122.4014, 10);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: insideWorkCoords.latitude,
      longitude: insideWorkCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 82,
      gps_accuracy: 10
    },
    token2
  );

  const alertsWork = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsWork.data.length !== 3 || alertsWork.data[0].alert_type !== "arrival" || !alertsWork.data[0].title.includes("Office Work")) {
    throw new Error(`Expected 3 alerts with latest being arrival at Work: ${JSON.stringify(alertsWork.data)}`);
  }
  console.log("✓ Scenario 7: Multiple Places maintain independent state (Passed)");

  // SCENARIO 8: Multiple users remain isolated
  // Initialize User 1 (Admin) outside Home Base first to establish state
  const outsideHomeU1 = getCoordsAtDistance(37.7749, -122.4194, 500);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u1",
    {
      latitude: outsideHomeU1.latitude,
      longitude: outsideHomeU1.longitude,
      device_name: "U1 Phone",
      entity_id: "device_tracker.u1_phone",
      user_id: user1Id,
      battery: 99,
      gps_accuracy: 5
    },
    token1
  );

  // Now move User 1 (Admin) inside Home Base to trigger transition
  const insideHomeU1 = getCoordsAtDistance(37.7749, -122.4194, 10);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u1",
    {
      latitude: insideHomeU1.latitude,
      longitude: insideHomeU1.longitude,
      device_name: "U1 Phone",
      entity_id: "device_tracker.u1_phone",
      user_id: user1Id,
      battery: 99,
      gps_accuracy: 5
    },
    token1
  );

  const alertsForUser2 = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token2);
  if (alertsForUser2.data.length !== 1 || alertsForUser2.data[0].alert_type !== "arrival" || !alertsForUser2.data[0].title.includes("Admin")) {
    throw new Error(`Expected User 2 to receive 1 arrival alert from Admin: ${JSON.stringify(alertsForUser2.data)}`);
  }
  console.log("✓ Scenario 8: Multiple users remain isolated (Passed)");

  // SCENARIO 9: notify_arrival_departure preference handling (disabled)
  // Disable notify_arrival_departure for User 1 (Admin)
  await makeRequest(
    "PUT",
    "/api/auth/profile",
    {
      notify_arrival_departure: false
    },
    token1
  );

  // Clear current alerts list for clean checking or read the counts
  const currentAlertsCount = (await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1)).data.length;

  // Move User 2 outside Office Work to trigger departure
  const outsideWorkCoords = getCoordsAtDistance(37.7891, -122.4014, 300);
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: outsideWorkCoords.latitude,
      longitude: outsideWorkCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 81,
      gps_accuracy: 10
    },
    token2
  );

  // User 1 (Admin) should NOT have a new alert because notify_arrival_departure is false
  const alertsPrefDisabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsPrefDisabled.data.length !== currentAlertsCount) {
    throw new Error(`Expected alert count to remain ${currentAlertsCount}, got ${alertsPrefDisabled.data.length} (suppression failed)`);
  }
  console.log("✓ Scenario 9: notify_arrival_departure = false suppresses alert (Passed)");

  // SCENARIO 10: notify_arrival_departure preference handling (enabled)
  // Enable preference again
  await makeRequest(
    "PUT",
    "/api/auth/profile",
    {
      notify_arrival_departure: true
    },
    token1
  );

  // Move User 2 back inside Office Work to trigger arrival
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: insideWorkCoords.latitude,
      longitude: insideWorkCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 80,
      gps_accuracy: 10
    },
    token2
  );

  // User 1 should now receive the arrival alert
  const alertsPrefEnabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsPrefEnabled.data.length !== currentAlertsCount + 1) {
    throw new Error(`Expected alert count to be ${currentAlertsCount + 1}, got ${alertsPrefEnabled.data.length}`);
  }
  console.log("✓ Scenario 10: notify_arrival_departure = true creates alert (Passed)");

  // SCENARIO 11: Location privacy enforcement - share_location = false
  // Turn off User 2 location sharing
  await makeRequest(
    "PUT",
    "/api/auth/profile",
    {
      share_location: false
    },
    token2
  );

  const prevAlertsCount = (await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1)).data.length;

  // Move User 2 outside Office Work to trigger departure
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: outsideWorkCoords.latitude,
      longitude: outsideWorkCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 79,
      gps_accuracy: 10
    },
    token2
  );

  // User 1 (Admin) should NOT receive any alert because User 2 has disabled location sharing
  const alertsPrivacyEnabled = await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1);
  if (alertsPrivacyEnabled.data.length !== prevAlertsCount) {
    throw new Error(`Expected alert count to remain ${prevAlertsCount}, got ${alertsPrivacyEnabled.data.length} (privacy bypass occurred!)`);
  }
  console.log("✓ Scenario 11: Privacy settings (share_location = false) suppress alerts (Passed)");

  // Restore location sharing
  await makeRequest(
    "PUT",
    "/api/auth/profile",
    {
      share_location: true
    },
    token2
  );

  // SCENARIO 12: Deleted Place no longer generates alerts
  // Delete Office Work Place
  const delPlaceRes = await makeRequest("DELETE", `/api/circles/${circleId}/places/${workPlaceId}`, undefined, token1);
  if (delPlaceRes.status !== 200) {
    throw new Error(`Failed to delete Place: ${delPlaceRes.status}`);
  }
  console.log("✓ Place 'Office Work' deleted successfully");

  const beforeMoveCount = (await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1)).data.length;

  // Move User 2 inside the old Office Work coordinates
  await makeRequest(
    "POST",
    "/api/webhook/test_webhook_u2",
    {
      latitude: insideWorkCoords.latitude,
      longitude: insideWorkCoords.longitude,
      device_name: "U2 Phone",
      entity_id: "device_tracker.u2_phone",
      user_id: user2Id,
      battery: 78,
      gps_accuracy: 10
    },
    token2
  );

  // No alerts should be created
  const afterMoveCount = (await makeRequest("GET", `/api/circles/${circleId}/alerts`, undefined, token1)).data.length;
  if (beforeMoveCount !== afterMoveCount) {
    throw new Error(`Expected alert count to stay ${beforeMoveCount}, got ${afterMoveCount} (deleted place triggered alert!)`);
  }
  console.log("✓ Scenario 12: Deleted Places no longer generate alerts (Passed)");

  console.log("\nALL GEOFENCE AND TRANSITION ENGINE TESTS PASSED SUCCESSFULLY! 🎉");
}

runGeofenceTests().catch((err) => {
  console.error("Geofence Test Suite Failed:", err);
  process.exit(1);
});
