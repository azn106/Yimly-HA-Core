import fs from "fs";
import path from "path";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
}

function runResponsiveLayoutTestSuite() {
  console.log("================================================================================");
  console.log("RUNNING RESPONSIVE UNIVERSAL PHONE LAYOUT VERIFICATION TEST SUITE");
  console.log("================================================================================");

  // 1. Inspect App.tsx
  console.log("\n[TEST 1] Verifying App.tsx layout architecture...");
  const appCode = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf-8");

  // Verify separate desktop navbar has been removed
  assert(!appCode.includes('className="hidden md:flex fixed bottom-6'), "Separate desktop navbar dock should NOT be present in App.tsx");
  console.log("✓ Confirmed: Separate desktop navbar dock has been removed.");

  // Verify Member Navbar dock is present without md:hidden
  assert(appCode.includes('nav className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none"'), "Member navbar dock must be present on ALL screen sizes without md:hidden breakpoint restriction");
  console.log("✓ Confirmed: Member navbar dock is universal across all viewports (phone, tablet, desktop).");

  // Verify Top-Left Family Circle title pill is present without md:hidden
  assert(appCode.includes('div className="fixed top-[max(0.75rem,env(safe-area-inset-top))] left-0 z-30 pointer-events-auto"'), "Top-Left Family Circle title pill must be universal without md:hidden");
  console.log("✓ Confirmed: Top-Left Family Circle control is universal.");

  // Verify Top-Right Settings button is present without md:hidden
  assert(appCode.includes('div className="fixed top-[max(0.75rem,env(safe-area-inset-top))] right-4 z-30 pointer-events-auto"'), "Top-Right Settings button must be universal without md:hidden");
  console.log("✓ Confirmed: Top-Right Settings control is universal.");

  // 2. Inspect MapComponent.tsx
  console.log("\n[TEST 2] Verifying MapComponent.tsx selected member card architecture...");
  const mapCode = fs.readFileSync(path.join(process.cwd(), "src/components/MapComponent.tsx"), "utf-8");

  // Verify separate desktop card block has been removed
  assert(!mapCode.includes('{selectedMember && !isCardHidden && !isMobile && ('), "Separate desktop card conditional block should NOT be present in MapComponent.tsx");
  console.log("✓ Confirmed: Separate desktop member card block removed.");

  // Verify phone bottom sheet card is used universally
  assert(mapCode.includes('{selectedMember && !isCardHidden && ('), "Universal selected member sheet card must be rendered without device-detection conditional branching");
  console.log("✓ Confirmed: Master phone view bottom sheet card is used for selected member across all device sizes.");

  console.log("\n================================================================================");
  console.log("RESPONSIVE UNIVERSAL PHONE LAYOUT TEST SUITE PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runResponsiveLayoutTestSuite();
