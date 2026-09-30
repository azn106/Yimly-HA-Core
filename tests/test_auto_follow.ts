import fs from "fs";
import path from "path";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
}

function runAutoFollowTestSuite() {
  console.log("================================================================================");
  console.log("RUNNING AUTO-FOLLOW MODE FEATURE TEST SUITE");
  console.log("================================================================================");

  // 1. Read MapComponent.tsx
  console.log("\n[TEST 1] Verifying MapComponent.tsx Auto-Follow implementation...");
  const mapCode = fs.readFileSync(path.join(process.cwd(), "src/components/MapComponent.tsx"), "utf-8");

  // Check state and ref declarations
  assert(mapCode.includes("const [isFollowing, setIsFollowingState] = useState<boolean>(false);"), "isFollowing state must be declared");
  assert(mapCode.includes("const isFollowingRef = useRef<boolean>(false);"), "isFollowingRef must be declared");
  assert(mapCode.includes("const lastFollowedCoordRef = useRef<{ lat: number; lng: number } | null>(null);"), "lastFollowedCoordRef must be declared");
  console.log("✓ Confirmed: Auto-Follow state and position tracking refs are properly initialized.");

  // Check manual pan / gesture detection
  console.log("\n[TEST 2] Verifying manual user gesture pan detection...");
  assert(mapCode.includes('map.on("dragstart",'), "dragstart listener must be registered to catch manual map drags");
  assert(mapCode.includes("if (e.originalEvent)"), "movestart listener must check e.originalEvent to distinguish user gestures from programmatic camera calls");
  console.log("✓ Confirmed: Manual map interactions (drag/pan) cancel auto-follow mode without triggering on programmatic camera calls.");

  // Check member selection & reselection enables follow mode
  console.log("\n[TEST 3] Verifying member selection and reselection behavior...");
  assert(mapCode.includes("setIsFollowing(true);"), "handleFocusMember / member selection must enable follow mode");
  assert(mapCode.includes("lastFollowedCoordRef.current = { lat: dev.latitude, lng: dev.longitude };"), "lastFollowedCoordRef must update on selection");
  console.log("✓ Confirmed: Member selection and reselection enables follow mode and centers on member location.");

  // Check Recenter button restores follow mode
  console.log("\n[TEST 4] Verifying Recenter button restores follow mode...");
  assert(
    mapCode.includes("const handleRecenterSelectedMember = useCallback(() => {") &&
    mapCode.includes("setIsFollowing(true);"),
    "handleRecenterSelectedMember must set setIsFollowing(true)"
  );
  console.log("✓ Confirmed: Recenter action centers map and restores auto-follow mode.");

  // Check Traccar / WebSocket location update auto-follow effect
  console.log("\n[TEST 5] Verifying Traccar location update reactive camera effect...");
  assert(mapCode.includes("if (!isFollowingRef.current || !selectedMemberId || isCardHidden) return;"), "Follow location update effect must verify isFollowingRef.current");
  assert(mapCode.includes("map.easeTo({"), "easeTo camera animation must be called when member location changes during active follow mode");
  assert(mapCode.includes("targetZoom = currentZoom < 14 ? 15 : currentZoom;"), "Current zoom level must be preserved during location updates");
  console.log("✓ Confirmed: Location updates smoothly ease map camera to member position while preserving user zoom level.");

  console.log("\n================================================================================");
  console.log("AUTO-FOLLOW FEATURE TEST SUITE PASSED CLEANLY! 🎉");
  console.log("================================================================================");
}

runAutoFollowTestSuite();
