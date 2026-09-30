import { isPhoneDevice } from "../src/lib/deviceDetection";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function runResponsiveLayoutTests() {
  console.log("================================================================================");
  console.log("RUNNING RESPONSIVE DEVICE LAYOUT & NAVIGATION TEST SUITE");
  console.log("================================================================================");

  // Helper to mock navigator and window globals safely in Node.js
  function mockEnvironment(userAgent: string, platform: string, maxTouchPoints: number, width: number, height: number) {
    const mockWin = {
      innerWidth: width,
      innerHeight: height,
      screen: { width, height },
      ontouchstart: maxTouchPoints > 0 ? {} : undefined
    };
    const mockNav = {
      userAgent,
      platform,
      maxTouchPoints,
      vendor: ""
    };

    Object.defineProperty(globalThis, "window", {
      value: mockWin,
      configurable: true,
      writable: true
    });
    Object.defineProperty(globalThis, "navigator", {
      value: mockNav,
      configurable: true,
      writable: true
    });
  }

  // 1. iPhone Portrait
  console.log("\n[TEST 1] Testing iPhone Portrait device classification...");
  mockEnvironment(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "iPhone",
    5,
    393,
    852
  );
  assert(isPhoneDevice() === true, "iPhone portrait should be classified as Phone layout");
  console.log("✓ iPhone Portrait correctly classified as Phone layout.");

  // 2. iPhone Landscape (rotated phone)
  console.log("\n[TEST 2] Testing iPhone Landscape (physically rotated) device classification...");
  mockEnvironment(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "iPhone",
    5,
    852,
    393
  );
  assert(isPhoneDevice() === true, "iPhone landscape should REMAIN Phone layout (not switch to desktop/tablet)");
  console.log("✓ iPhone Landscape correctly maintains Phone layout rules regardless of physical rotation.");

  // 3. Android Phone Portrait
  console.log("\n[TEST 3] Testing Android Phone (Pixel / Galaxy) device classification...");
  mockEnvironment(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
    "Linux armv8l",
    5,
    412,
    915
  );
  assert(isPhoneDevice() === true, "Android phone portrait should be classified as Phone layout");
  console.log("✓ Android Phone correctly classified as Phone layout.");

  // 4. iPad Portrait
  console.log("\n[TEST 4] Testing iPad Portrait device classification...");
  mockEnvironment(
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "iPad",
    5,
    820,
    1180
  );
  assert(isPhoneDevice() === false, "iPad portrait should NOT be classified as Phone layout (uses tablet landscape layout)");
  console.log("✓ iPad Portrait correctly classified as Tablet/Desktop layout.");

  // 5. iPad Landscape
  console.log("\n[TEST 5] Testing iPad Landscape device classification...");
  mockEnvironment(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "MacIntel",
    5, // MacIntel with touch points is iPadOS 13+
    1180,
    820
  );
  assert(isPhoneDevice() === false, "iPadOS Desktop Mode should be classified as Tablet/Desktop layout");
  console.log("✓ iPad Landscape correctly classified as Tablet/Desktop layout.");

  // 6. Android Tablet Landscape
  console.log("\n[TEST 6] Testing Android Tablet device classification...");
  mockEnvironment(
    "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Linux aarch64",
    5,
    1280,
    800
  );
  assert(isPhoneDevice() === false, "Android Tablet (without Mobile token) should be Tablet/Desktop layout");
  console.log("✓ Android Tablet correctly classified as Tablet/Desktop layout.");

  // 7. Desktop Mac / PC Chrome
  console.log("\n[TEST 7] Testing Desktop PC / Mac browser device classification...");
  mockEnvironment(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "MacIntel",
    0,
    1920,
    1080
  );
  assert(isPhoneDevice() === false, "Desktop PC/Mac should be classified as Tablet/Desktop layout");
  console.log("✓ Desktop PC / Mac correctly classified as Tablet/Desktop layout.");

  console.log("\n================================================================================");
  console.log("RESPONSIVE DEVICE LAYOUT & NAVIGATION TEST SUITE PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runResponsiveLayoutTests();
