/**
 * Utility to accurately distinguish Phone-sized devices (iPhone, Android phones)
 * from Tablets (iPad, Android tablets) and Desktop/PC browsers.
 */
export function isPhoneDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera || "";

  // 1. Explicit iPad check (including iPadOS 13+ desktop user agent override)
  const isIPad =
    /iPad/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // 2. Explicit Android Tablet check (Android UA without "Mobile" token is a Tablet)
  const isAndroidTablet = /Android/i.test(userAgent) && !/Mobile/i.test(userAgent);

  if (isIPad || isAndroidTablet) {
    return false; // Tablet -> tablet landscape layout
  }

  // 3. Explicit Phone UserAgent check (iPhone, iPod, Android Phone with Mobile token, Windows Phone, etc.)
  const isMobilePhoneUA = /iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  if (isMobilePhoneUA) {
    return true; // Phone -> phone layout
  }

  // 4. Viewport width check (handles AI Studio Preview phone frame, responsive devtools, and small screens)
  const width = window.innerWidth || (window.screen ? window.screen.width : 0);
  if (width > 0 && width <= 640) {
    return true; // Phone viewport
  }

  // Default to false for Tablets and Desktop / PC browsers (> 640px)
  return false;
}
