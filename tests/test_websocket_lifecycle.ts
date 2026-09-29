import { HAWebSocketManager } from "../src/lib/haWebSocket";
import WebSocket from "ws";

// Helper for assertions
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Mock WebSocket class that simulates browser WebSocket events and counts instances
class MockBrowserWebSocket {
  static instances: MockBrowserWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  public url: string;
  public readyState: number = MockBrowserWebSocket.CONNECTING;
  public onopen: (() => void) | null = null;
  public onmessage: ((e: any) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((e: any) => void) | null = null;
  public sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockBrowserWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockBrowserWebSocket.CLOSING;
    setTimeout(() => {
      this.readyState = MockBrowserWebSocket.CLOSED;
      if (this.onclose) (this.onclose as any)({ code: 1000, reason: "Normal Closure", wasClean: true });
    }, 0);
  }

  // Test simulation helpers
  simulateOpen() {
    this.readyState = MockBrowserWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  simulateServerMessage(msg: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(msg) });
    }
  }

  simulateDrop() {
    this.readyState = MockBrowserWebSocket.CLOSED;
    if (this.onclose) (this.onclose as any)({ code: 1006, reason: "Abnormal Disconnect", wasClean: false });
  }
}

async function runWebSocketLifecycleTests() {
  console.log("============================================================");
  console.log("RUNNING WEBSOCKET CONNECTION LIFECYCLE TEST SUITE");
  console.log("============================================================\n");

  const TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test";

  // --------------------------------------------------------------------------
  // TEST 1: Two independent connection triggers occurring in the same tick
  //         create exactly ONE physical WebSocket.
  // --------------------------------------------------------------------------
  console.log("TEST 1: Two independent connection triggers in the same tick...");
  MockBrowserWebSocket.instances = [];
  const manager1 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 50,
    unmountDebounceMs: 20
  });

  // Two independent calls in the exact same synchronous tick
  const wsA = manager1.connect(TEST_TOKEN);
  const wsB = manager1.connect(TEST_TOKEN);

  assert(MockBrowserWebSocket.instances.length === 1, `Expected 1 physical socket created, got ${MockBrowserWebSocket.instances.length}`);
  assert(wsA === wsB, "Expected both calls to return the exact same WebSocket instance");
  assert(manager1.getActiveSocket() === wsA, "Active socket matches instance");
  manager1.disconnect(true);
  console.log("✓ TEST 1 PASSED: Exactly ONE physical WebSocket created for racing triggers in same tick.\n");

  // --------------------------------------------------------------------------
  // TEST 2: React StrictMode mount → cleanup → remount creates exactly ONE active socket.
  // --------------------------------------------------------------------------
  console.log("TEST 2: React StrictMode mount → cleanup → remount...");
  MockBrowserWebSocket.instances = [];
  const manager2 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 50,
    unmountDebounceMs: 50
  });

  // Mount 1
  const unsub1 = manager2.subscribe({ id: "strict-mode-test" });
  const socket1 = manager2.connect(TEST_TOKEN);
  assert(MockBrowserWebSocket.instances.length === 1, "Mount 1 created 1 socket");

  // StrictMode immediate cleanup (unmount)
  unsub1();
  assert(manager2.hasPendingDisconnectTimer(), "Pending disconnect timer scheduled during StrictMode unmount");

  // StrictMode immediate remount (runs synchronously or in microtask before timer expires)
  const unsub2 = manager2.subscribe({ id: "strict-mode-test" });
  const socket2 = manager2.connect(TEST_TOKEN);

  assert(!manager2.hasPendingDisconnectTimer(), "Pending disconnect timer was cancelled by remount");
  assert(MockBrowserWebSocket.instances.length === 1, `Expected still exactly 1 socket after StrictMode remount, got ${MockBrowserWebSocket.instances.length}`);
  assert(socket1 === socket2, "Active socket preserved across StrictMode remount without duplicate creation");

  unsub2();
  manager2.disconnect(true);
  console.log("✓ TEST 2 PASSED: React StrictMode mount -> cleanup -> remount preserves exactly ONE socket.\n");

  // --------------------------------------------------------------------------
  // TEST 3: Reconnect cannot race with a normal connection attempt.
  // --------------------------------------------------------------------------
  console.log("TEST 3: Reconnect cannot race with a normal connection attempt...");
  MockBrowserWebSocket.instances = [];
  const manager3 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 80,
    unmountDebounceMs: 20
  });

  manager3.connect(TEST_TOKEN);
  const activeWs3 = MockBrowserWebSocket.instances[0];
  activeWs3.simulateOpen();

  // Simulate unexpected connection drop which schedules reconnect in 80ms
  activeWs3.simulateDrop();
  assert(manager3.hasPendingReconnectTimer(), "Reconnect timer is scheduled after socket drop");

  // Before the 80ms reconnect timer fires, a normal connection attempt occurs (e.g. user action / auth)
  const manualWs = manager3.connect(TEST_TOKEN);
  assert(!manager3.hasPendingReconnectTimer(), "Manual connect immediately cancelled the pending reconnect timer");
  assert(MockBrowserWebSocket.instances.length === 2, "1 replacement socket created, not 2");

  // Wait 100ms to verify that the cancelled reconnect timer does NOT fire
  await new Promise((r) => setTimeout(r, 100));
  assert(MockBrowserWebSocket.instances.length === 2, `Expected no additional socket from cancelled reconnect, got ${MockBrowserWebSocket.instances.length}`);

  manager3.disconnect(true);
  console.log("✓ TEST 3 PASSED: Reconnect cannot race with normal connection attempt.\n");

  // --------------------------------------------------------------------------
  // TEST 4: A stale socket's onclose cannot create another socket or clear active socket.
  // --------------------------------------------------------------------------
  console.log("TEST 4: Stale socket onclose cannot create another socket...");
  MockBrowserWebSocket.instances = [];
  const manager4 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 50,
    unmountDebounceMs: 20
  });

  // Socket 1 created
  const ws1 = manager4.connect(TEST_TOKEN);
  const mock1 = MockBrowserWebSocket.instances[0];

  // Token change or replacement occurs before socket 1 closes
  const NEW_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token2";
  const ws2 = manager4.connect(NEW_TOKEN);
  const mock2 = MockBrowserWebSocket.instances[1];
  assert(ws1 !== ws2, "New socket created for new token");
  assert(manager4.getActiveSocket() === ws2, "Socket 2 is active");

  // Now stale socket 1's delayed onclose fires
  mock1.simulateDrop();

  // Active socket MUST still be socket 2, and NO reconnect timer should be scheduled by stale socket
  assert(manager4.getActiveSocket() === ws2, "Active socket was NOT overwritten or cleared by stale socket onclose");
  assert(!manager4.hasPendingReconnectTimer(), "Stale socket onclose did NOT schedule any reconnect");
  assert(MockBrowserWebSocket.instances.length === 2, "No extra socket was spawned by stale onclose");

  manager4.disconnect(true);
  console.log("✓ TEST 4 PASSED: Stale socket onclose is safely ignored.\n");

  // --------------------------------------------------------------------------
  // TEST 5: Multiple auth/session state transitions cannot create duplicate sockets.
  // --------------------------------------------------------------------------
  console.log("TEST 5: Multiple auth/session state transitions...");
  MockBrowserWebSocket.instances = [];
  const manager5 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 50,
    unmountDebounceMs: 20
  });

  // Simulate multiple transitions: checking -> authenticated -> re-render -> re-render
  for (let i = 0; i < 5; i++) {
    manager5.connect(TEST_TOKEN);
  }

  assert(MockBrowserWebSocket.instances.length === 1, `Expected exactly 1 socket across 5 transitions, got ${MockBrowserWebSocket.instances.length}`);
  manager5.disconnect(true);
  console.log("✓ TEST 5 PASSED: Multiple state transitions do not create duplicate sockets.\n");

  // --------------------------------------------------------------------------
  // TEST 6: Genuine connection failure creates exactly one replacement.
  // --------------------------------------------------------------------------
  console.log("TEST 6: Genuine connection failure creates exactly one replacement...");
  MockBrowserWebSocket.instances = [];
  const manager6 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 40,
    unmountDebounceMs: 20
  });

  manager6.connect(TEST_TOKEN);
  const initialMock = MockBrowserWebSocket.instances[0];
  initialMock.simulateOpen();

  // Socket genuine drop
  initialMock.simulateDrop();
  assert(manager6.getActiveSocket() === null, "Active socket cleared after genuine drop");
  assert(manager6.hasPendingReconnectTimer(), "Reconnect scheduled");

  // Wait for reconnect timer to fire
  await new Promise((r) => setTimeout(r, 60));

  assert(MockBrowserWebSocket.instances.length === 2, `Expected exactly 1 replacement (total 2), got ${MockBrowserWebSocket.instances.length}`);
  assert((manager6.getActiveSocket() as any) === MockBrowserWebSocket.instances[1], "Replacement socket is now active");

  manager6.disconnect(true);
  console.log("✓ TEST 6 PASSED: Genuine connection failure creates exactly ONE replacement.\n");

  // --------------------------------------------------------------------------
  // TEST 7: Logout/cleanup prevents reconnect.
  // --------------------------------------------------------------------------
  console.log("TEST 7: Logout/cleanup prevents reconnect...");
  MockBrowserWebSocket.instances = [];
  const manager7 = new HAWebSocketManager({
    webSocketClass: MockBrowserWebSocket,
    reconnectIntervalMs: 30,
    unmountDebounceMs: 20
  });

  manager7.connect(TEST_TOKEN);
  const mock7 = MockBrowserWebSocket.instances[0];
  mock7.simulateOpen();

  // User logs out
  manager7.disconnect(true);

  assert(manager7.getActiveSocket() === null, "Active socket cleared on logout");
  assert(!manager7.hasPendingReconnectTimer(), "No reconnect scheduled on logout");

  // Simulate late onclose from closing socket
  mock7.simulateDrop();
  assert(!manager7.hasPendingReconnectTimer(), "Late onclose after logout did NOT schedule reconnect");

  // Wait to verify no sockets spawned
  await new Promise((r) => setTimeout(r, 60));
  assert(MockBrowserWebSocket.instances.length === 1, `No reconnect occurred after logout, count: ${MockBrowserWebSocket.instances.length}`);

  console.log("✓ TEST 7 PASSED: Logout / cleanup successfully prevents reconnect.\n");

  // --------------------------------------------------------------------------
  // TEST 8: Live WebSocket connection against local server with real handshake
  // --------------------------------------------------------------------------
  console.log("TEST 8: Real WebSocket connection to local server /api/websocket...");
  
  // Register a test user to obtain a real JWT token
  const http = await import("http");
  const token = await new Promise<string>((resolve, reject) => {
    const postData = JSON.stringify({
      username: `ws_live_user_${Date.now()}`,
      password: "TestPassword123!",
      display_name: "WS Live User"
    });
    const req = http.request(
      "http://127.0.0.1:3000/api/auth/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            resolve(data.access_token);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });

  const liveManager = new HAWebSocketManager({
    wsUrl: "ws://127.0.0.1:3000/api/websocket",
    webSocketClass: WebSocket,
    reconnectIntervalMs: 4000
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      liveManager.disconnect(true);
      reject(new Error("Live WebSocket handshake timed out"));
    }, 5000);

    let stateChangedReceived = false;

    liveManager.subscribe({
      id: "live-test",
      onConnected: () => {
        console.log("  ✓ Live WebSocket handshake succeeded (auth_ok received).");
        clearTimeout(timeout);
        liveManager.disconnect(true);
        resolve();
      }
    });

    // Concurrently trigger connect twice to verify only ONE physical connection is established to server
    const s1 = liveManager.connect(token);
    const s2 = liveManager.connect(token);
    assert(s1 === s2, "Live manager returned identical socket for concurrent connect calls");
  });

  console.log("✓ TEST 8 PASSED: Live WebSocket handshake succeeded with real server.\n");

  console.log("============================================================");
  console.log("ALL 8 WEBSOCKET LIFECYCLE TESTS PASSED! 🎉");
  console.log("============================================================\n");
}

runWebSocketLifecycleTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
