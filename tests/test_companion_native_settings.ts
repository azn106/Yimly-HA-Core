import {
  isCompanionApp,
  hasNativeSettingsScreen,
  showNativeSettings,
  requestExternalConfig,
  handleIncomingExternalBusMessage,
  setExternalConfig,
  notifyExternalBus
} from "../src/lib/externalBus";

async function runNativeSettingsTests() {
  console.log("============================================================");
  console.log("RUNNING COMPANION APP NATIVE SETTINGS INTEGRATION TESTS");
  console.log("============================================================");

  let sentMessages: any[] = [];

  // Mock global window objects
  const originalWindow = global.window;
  (global as any).window = {
    location: { protocol: "http:", host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    sessionStorage: {
      _store: {} as Record<string, string>,
      getItem(k: string) { return this._store[k] || null; },
      setItem(k: string, v: string) { this._store[k] = v; },
      removeItem(k: string) { delete this._store[k]; }
    },
    localStorage: {
      _store: {} as Record<string, string>,
      getItem(k: string) { return this._store[k] || null; },
      setItem(k: string, v: string) { this._store[k] = v; },
      removeItem(k: string) { delete this._store[k]; }
    },
    externalAppV2: {
      postMessage: (msgStr: string) => {
        const msg = JSON.parse(msgStr);
        sentMessages.push(msg);
      }
    }
  };

  // Test 1: Browser / PWA Environment (no externalApp bridge, no external_auth)
  console.log("\n1. Testing Browser / PWA Environment (no Companion App bridge)...");
  delete (global as any).window.externalAppV2;
  setExternalConfig(null);
  
  if (isCompanionApp()) {
    throw new Error("Expected isCompanionApp() to be false in standard browser environment");
  }
  if (hasNativeSettingsScreen()) {
    throw new Error("Expected hasNativeSettingsScreen() to be false in standard browser environment");
  }
  const showResultBrowser = showNativeSettings();
  if (showResultBrowser !== false) {
    throw new Error("Expected showNativeSettings() to return false in standard browser environment");
  }
  console.log("✓ Standard browser / PWA environment correctly preserves web settings fallback.");

  // Test 2: Companion App Environment (Android V2) without native settings capability
  console.log("\n2. Testing Companion App Environment without hasSettingsScreen...");
  sentMessages = [];
  (global as any).window.externalAppV2 = {
    postMessage: (msgStr: string) => {
      sentMessages.push(JSON.parse(msgStr));
    }
  };
  
  if (!isCompanionApp()) {
    throw new Error("Expected isCompanionApp() to be true when window.externalAppV2 is present");
  }

  // App reports config without hasSettingsScreen
  handleIncomingExternalBusMessage({
    type: "result",
    id: 101,
    success: true,
    result: {
      hasSettingsScreen: false,
      canClose: true
    }
  });

  if (hasNativeSettingsScreen()) {
    throw new Error("Expected hasNativeSettingsScreen() to be false when app reports hasSettingsScreen: false");
  }

  const showResultNoSettings = showNativeSettings();
  if (showResultNoSettings !== false) {
    throw new Error("Expected showNativeSettings() to return false when hasSettingsScreen is false");
  }
  if (sentMessages.some((m) => m.type === "config_screen/show")) {
    throw new Error("config_screen/show should NOT be dispatched when capability is false");
  }
  console.log("✓ Companion App without hasSettingsScreen capability safely preserves web settings.");

  // Test 3: Companion App Environment (Android V2 / iOS WebKit) with hasSettingsScreen = true
  console.log("\n3. Testing Companion App Environment with hasSettingsScreen = true...");
  sentMessages = [];
  handleIncomingExternalBusMessage({
    type: "result",
    id: 102,
    success: true,
    result: {
      hasSettingsScreen: true,
      canClose: true,
      hasSidebar: false
    }
  });

  if (!hasNativeSettingsScreen()) {
    throw new Error("Expected hasNativeSettingsScreen() to be true");
  }

  const showResultSuccess = showNativeSettings();
  if (showResultSuccess !== true) {
    throw new Error("Expected showNativeSettings() to return true");
  }

  const configScreenMsg = sentMessages.find((m) => m.type === "config_screen/show");
  if (!configScreenMsg) {
    throw new Error("Expected 'config_screen/show' message to be dispatched over external bus");
  }
  console.log("✓ Official 'config_screen/show' external-bus command successfully dispatched to native Companion App.");

  // Test 4: Incoming config/get from Native App handshake
  console.log("\n4. Testing Incoming 'config/get' query handling from Native App...");
  sentMessages = [];
  handleIncomingExternalBusMessage({
    type: "config/get",
    id: 55
  });

  const responseMsg = sentMessages.find((m) => m.type === "config/get" && m.payload?.result?.ha_version);
  if (!responseMsg) {
    throw new Error("Expected response to incoming 'config/get' query");
  }
  if (responseMsg.id !== 55) {
    throw new Error(`Expected response to preserve query id 55, got: ${responseMsg.id}`);
  }
  console.log("✓ Incoming 'config/get' query received and answered with instance metadata.");

  // Test 5: Outgoing requestExternalConfig() handshake
  console.log("\n5. Testing Outgoing requestExternalConfig() handshake...");
  sentMessages = [];
  const reqPromise = requestExternalConfig(500);
  const outConfigReq = sentMessages.find((m) => m.type === "config/get");
  if (!outConfigReq) {
    throw new Error("Expected outgoing 'config/get' request to be dispatched");
  }
  // Simulate native app response
  handleIncomingExternalBusMessage({
    type: "result",
    id: outConfigReq.id,
    success: true,
    result: {
      hasSettingsScreen: true,
      appVersion: "2024.1.0"
    }
  });
  const config = await reqPromise;
  if (!config?.hasSettingsScreen) {
    throw new Error("Expected requestExternalConfig to resolve with hasSettingsScreen: true");
  }
  console.log("✓ Outgoing requestExternalConfig() successfully retrieved Companion App capabilities.");

  console.log("\n============================================================");
  console.log("ALL NATIVE COMPANION SETTINGS TESTS PASSED! 🎉");
  console.log("============================================================");
}

runNativeSettingsTests().catch((err) => {
  console.error("Test Failed:", err);
  process.exit(1);
});
