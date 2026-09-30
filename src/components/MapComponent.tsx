import React, { useEffect, useRef, useState, useCallback, useMemo, useImperativeHandle } from "react";
import { motion, useMotionValue, animate } from "motion/react";
import * as maplibregl from "maplibre-gl";
import { CircleMember, LocationHistoryItem, UserInfo, MemberDeviceLocation, Place } from "../types";
import { getMapStyle } from "../lib/mapStyles";
import { renderMarkerHTML, renderPrivateDeviceMarkerHTML, getMarkerDimensions, getClusterScale, getBalloonOffsets, calculateDistanceMeters, StackedMemberInfo, renderPlaceMarkerHTML, getPlaceIconSVGString, escapeHtml } from "../lib/markerRenderer";
import { getAvatarColor, DEFAULT_AVATAR_COLOR } from "../lib/avatarColor";
import { DeviceIcon } from "./DeviceIcon";
import { 
  MapPin, 
  RefreshCw, 
  Plus, 
  Minus, 
  Navigation, 
  History, 
  Smartphone, 
  Battery, 
  BatteryCharging,
  Clock, 
  X,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  Route,
  Volume2,
  BellRing
} from "lucide-react";

export interface MapComponentHandle {
  focusMember: (memberOrId: CircleMember | number) => void;
}

// Helper to format relative last updated time for selected user card
function formatRelativeLastUpdated(lastUpdatedStr?: string | null, currentTimeMs?: number): string {
  if (!lastUpdatedStr) {
    return "Last updated —";
  }

  let parseable = lastUpdatedStr;
  if (parseable.includes(" ") && !parseable.includes("T")) {
    parseable = parseable.replace(" ", "T");
  }
  if (!parseable.endsWith("Z") && !parseable.includes("+") && !parseable.includes("-", 11)) {
    parseable += "Z";
  }

  const d = new Date(parseable);
  let timeMs = d.getTime();
  if (isNaN(timeMs)) {
    const d2 = new Date(lastUpdatedStr);
    timeMs = d2.getTime();
    if (isNaN(timeMs)) {
      return "Last updated —";
    }
  }

  const nowMs = currentTimeMs ?? Date.now();
  const diffMs = Math.max(0, nowMs - timeMs);
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 10) {
    return "Last updated just now";
  }
  if (diffSec < 60) {
    return `Last updated ${diffSec} sec ago`;
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `Last updated ${diffMin} min ago`;
  }

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return `Last updated ${diffHr} hr ago`;
  }

  const diffDays = Math.floor(diffHr / 24);
  return `Last updated ${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

// Perimeter math and boundary intersection helpers for Life360-style off-screen indicators
function getIntersectionPoint(
  cx: number,
  cy: number,
  px: number,
  py: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
) {
  const dx = px - cx;
  const dy = py - cy;

  let x = px;
  let y = py;
  let edge: "top" | "bottom" | "left" | "right" = "top";

  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy, edge };
  }

  // Check intersection with vertical boundaries (right and left)
  if (dx !== 0) {
    if (px > maxX) {
      const t = (maxX - cx) / dx;
      const iy = cy + dy * t;
      if (iy >= minY && iy <= maxY) {
        return { x: maxX, y: iy, edge: "right" as const };
      }
    } else if (px < minX) {
      const t = (minX - cx) / dx;
      const iy = cy + dy * t;
      if (iy >= minY && iy <= maxY) {
        return { x: minX, y: iy, edge: "left" as const };
      }
    }
  }

  // Check intersection with horizontal boundaries (bottom and top)
  if (dy !== 0) {
    if (py > maxY) {
      const t = (maxY - cy) / dy;
      const ix = cx + dx * t;
      if (ix >= minX && ix <= maxX) {
        return { x: ix, y: maxY, edge: "bottom" as const };
      }
    } else if (py < minY) {
      const t = (minY - cy) / dy;
      const ix = cx + dx * t;
      if (ix >= minX && ix <= maxX) {
        return { x: ix, y: minY, edge: "top" as const };
      }
    }
  }

  // Extreme fallback coordinate clipping
  if (px > maxX) x = maxX;
  else if (px < minX) x = minX;
  if (py > maxY) y = maxY;
  else if (py < minY) y = minY;

  if (x === maxX) edge = "right";
  else if (x === minX) edge = "left";
  else if (y === maxY) edge = "bottom";
  else edge = "top";

  return { x, y, edge };
}

function getCoordsFromPerimeter(s: number, minX: number, maxX: number, minY: number, maxY: number) {
  const w = maxX - minX;
  const h = maxY - minY;

  if (s < w) {
    return { x: minX + s, y: minY, edge: "top" as const };
  } else if (s <= w + h) {
    return { x: maxX, y: minY + (s - w), edge: "right" as const };
  } else if (s < 2 * w + h) {
    return { x: maxX - (s - (w + h)), y: maxY, edge: "bottom" as const };
  } else {
    return { x: minX, y: maxY - (s - (2 * w + h)), edge: "left" as const };
  }
}

export interface MapComponentProps {
  members: CircleMember[];
  places?: Place[];
  currentUser?: UserInfo | null;
  onRefresh: () => void;
  loading: boolean;
  mapStyle?: string | null;
  mapPinType?: string | null;
  selectedIconSize?: number | null;
  unselectedIconSize?: number | null;
  selectedMemberId?: number | null;
  onSelectMemberId?: (id: number | null) => void;
  onSetDefaultDevice?: (memberId: number | string, entityId: string) => void;
}

export type RangePresetId = 'today' | 'week' | 'month';

export interface ActiveRangeConfig {
  type: 'preset' | 'custom';
  presetId?: string; // 'today' | 'week' | 'month'
  hours?: number | null;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  label: string; // e.g. "Today", "Week", "Month", "Custom: 18 Sep – 21 Sep"
}

export interface RangePreset {
  id: RangePresetId;
  label: string;
  hours: number;
}

export const PRESET_RANGES: RangePreset[] = [
  { id: "today", label: "Today", hours: 24 },
  { id: "week", label: "Week", hours: 168 },
  { id: "month", label: "Month", hours: 720 },
];

function toDateInputValue(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCustomRangeLabel(startStr: string, endStr: string): string {
  const parts1 = startStr.split("-");
  const parts2 = endStr.split("-");
  if (parts1.length === 3 && parts2.length === 3) {
    const d1 = new Date(Number(parts1[0]), Number(parts1[1]) - 1, Number(parts1[2]));
    const d2 = new Date(Number(parts2[0]), Number(parts2[1]) - 1, Number(parts2[2]));
    const s1 = d1.toLocaleDateString("en-US", { day: "numeric", month: "short" });
    const s2 = d2.toLocaleDateString("en-US", { day: "numeric", month: "short" });
    if (startStr === endStr) {
      return `Custom: ${s1}`;
    }
    return `Custom: ${s1} – ${s2}`;
  }
  return `Custom: ${startStr} – ${endStr}`;
}

/**
 * Calculates a smooth color gradient along the member's journey based on their saved pastel avatar color.
 * 
 * EARLIEST HISTORY (progress = 0.0):
 * -> softer / lighter version of the member's pastel colour
 * 
 * MIDDLE OF JOURNEY (progress = 0.5):
 * -> progressively deeper version
 * 
 * LATEST / NEWEST HISTORY (progress = 1.0):
 * -> darker matching version of the member's pastel colour
 * 
 * Strictly preserves the exact same color family (hue) throughout the entire journey.
 */
function getRouteGradientColor(hexColor?: string | null, progress: number = 1.0): string {
  const safeHex = getAvatarColor(hexColor);
  let hex = safeHex.replace("#", "");
  if (hex.length === 3) {
    hex = hex.split("").map((c) => c + c).join("");
  }
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm:
        h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0);
        break;
      case gNorm:
        h = (bNorm - rNorm) / d + 2;
        break;
      case bNorm:
        h = (rNorm - gNorm) / d + 4;
        break;
    }
    h /= 6;
  }

  // Clamped progress between 0 (oldest/earliest) and 1 (latest/newest)
  const clampedProgress = Math.max(0, Math.min(1, progress));

  // Earliest / oldest history endpoint: soft, subtle light pastel in the same hue
  const lightL = Math.min(0.85, Math.max(0.76, l * 1.15));
  const lightS = Math.min(0.55, Math.max(0.35, s * 0.85));

  // Latest / newest history endpoint: slightly deeper matching pastel (NOT dark or harsh)
  const darkL = Math.min(0.52, Math.max(0.42, l * 0.72));
  const darkS = Math.min(0.70, Math.max(0.48, s * 1.10));

  // Smooth low-contrast interpolation along the journey timeline
  const targetL = lightL + (darkL - lightL) * clampedProgress;
  const targetS = lightS + (darkS - lightS) * clampedProgress;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = targetL < 0.5 ? targetL * (1 + targetS) : targetL + targetS - targetL * targetS;
  const p = 2 * targetL - q;
  const resR = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const resG = Math.round(hue2rgb(p, q, h) * 255);
  const resB = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return `#${resR.toString(16).padStart(2, "0")}${resG.toString(16).padStart(2, "0")}${resB.toString(16).padStart(2, "0")}`;
}

function getDarkerRouteColor(hexColor?: string | null): string {
  return getRouteGradientColor(hexColor, 1.0);
}

function getSubtleTintStyle(): string {
  return "rgba(255, 255, 255, 0.85)";
}

// Calculate distance in km between two coordinates using Haversine formula
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Coordinate validation helper to guarantee valid MapLibre LngLat ranges (-90 <= lat <= 90, -180 <= lon <= 180)
function isValidCoordinate(lat: any, lon: any): boolean {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return false;
  const numLat = typeof lat === "number" ? lat : parseFloat(lat);
  const numLon = typeof lon === "number" ? lon : parseFloat(lon);
  if (isNaN(numLat) || isNaN(numLon) || !isFinite(numLat) || !isFinite(numLon)) return false;
  if (numLat < -90 || numLat > 90 || numLon < -180 || numLon > 180) return false;
  return true;
}

function isValidPlace(place: any): place is Place {
  if (!place || typeof place !== "object") return false;
  if (!isValidCoordinate(place.latitude, place.longitude)) return false;
  if (typeof place.radius !== "number" || isNaN(place.radius) || !isFinite(place.radius) || place.radius <= 0) return false;
  return true;
}

function createGeoJSONCircle(
  center: [number, number],
  radiusInMeters: number,
  points = 64,
  properties: Record<string, any> = {}
): GeoJSON.Feature<GeoJSON.Polygon> {
  const [lng, lat] = center;
  if (!isValidCoordinate(lat, lng)) {
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[]] },
      properties
    };
  }

  const lng1 = (lng * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const R = 6371000.0; // Earth radius in meters
  const d = Math.max(0, radiusInMeters) / R; // angular distance in radians

  const coordinates: [number, number][] = [];

  for (let i = 0; i <= points; i++) {
    const bearing = (i * 2 * Math.PI) / points;
    const sinLat2 = Math.max(-1, Math.min(1, Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing)));
    const lat2 = Math.asin(sinLat2);
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );

    const outLat = Math.max(-89.999999, Math.min(89.999999, (lat2 * 180) / Math.PI));
    let outLng = (lng2 * 180) / Math.PI;
    outLng = (((outLng + 180) % 360) + 360) % 360 - 180;

    coordinates.push([outLng, outLat]);
  }

  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [coordinates]
    },
    properties
  };
}

export const MapComponent = React.forwardRef<MapComponentHandle, MapComponentProps>(function MapComponent({ 
  members, 
  places,
  currentUser,
  onRefresh, 
  loading, 
  mapStyle,
  mapPinType,
  selectedIconSize,
  unselectedIconSize,
  selectedMemberId: propSelectedMemberId,
  onSelectMemberId,
  onSetDefaultDevice
}, ref) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<{ [key: string]: maplibregl.Marker }>({});
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const currentTargetCoordRef = useRef<[number, number] | null>(null);
  const activePlacePopupRef = useRef<maplibregl.Popup | null>(null);

  const [internalSelectedMemberId, setInternalSelectedMemberId] = useState<number | null>(null);
  const isControlled = propSelectedMemberId !== undefined;
  const selectedMemberId = isControlled ? propSelectedMemberId : internalSelectedMemberId;

  // Auto-Follow Mode States & Refs
  const [isFollowing, setIsFollowingState] = useState<boolean>(false);
  const isFollowingRef = useRef<boolean>(false);
  const lastFollowedCoordRef = useRef<{ lat: number; lng: number } | null>(null);

  const setIsFollowing = useCallback((val: boolean) => {
    isFollowingRef.current = val;
    setIsFollowingState(val);
  }, []);

  const setSelectedMemberId = useCallback((id: number | null) => {
    setInternalSelectedMemberId(id);
    if (onSelectMemberId) {
      onSelectMemberId(id);
    }
  }, [onSelectMemberId]);

  // Card View and History Navigation States
  const [isCardHidden, setIsCardHidden] = useState<boolean>(false);
  const [sheetState, setSheetState] = useState<"expanded" | "compact">("expanded");
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [mobilePage, setMobilePage] = useState<number>(0);
  const [desktopCardTab, setDesktopCardTab] = useState<"info" | "history" | "devices">("info");

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768); // Match tailwind's md breakpoint
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Reset sheet state to expanded when selected member changes
  useEffect(() => {
    if (selectedMemberId !== null && selectedMemberId !== undefined) {
      setSheetState("expanded");
      setMobilePage(0);
    }
  }, [selectedMemberId]);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [isCustomRangeActive, setIsCustomRangeActive] = useState<boolean>(false);
  const [activeRange, setActiveRange] = useState<ActiveRangeConfig>({
    type: 'preset',
    presetId: 'today',
    hours: 24,
    label: 'Today'
  });
  const navMemberHistoryRef = useRef<number[]>([]);

  // Mobile touch gesture states and refs
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const lastTouchRef = useRef<{ y: number; time: number } | null>(null);
  const axisLockRef = useRef<"x" | "y" | null>(null);
  const startTimeRef = useRef<number>(0);
  const isScrollableStartRef = useRef<boolean>(false);

  const COLLAPSED_SHEET_Y = 280;
  const sheetY = useMotionValue(sheetState === "expanded" ? 0 : COLLAPSED_SHEET_Y);
  const isDraggingYRef = useRef<boolean>(false);
  const isGestureReleaseRef = useRef<boolean>(false);
  const sheetStartPosRef = useRef<number>(sheetState === "expanded" ? 0 : COLLAPSED_SHEET_Y);

  const [dragOffsetX, setDragOffsetX] = useState<number>(0);

  // Sync sheetY when sheetState changes programmatically (e.g. tap on handle or collapse button)
  useEffect(() => {
    if (isGestureReleaseRef.current) {
      isGestureReleaseRef.current = false;
      return;
    }
    if (!isDraggingYRef.current) {
      animate(sheetY, sheetState === "expanded" ? 0 : COLLAPSED_SHEET_Y, {
        type: "spring",
        stiffness: 300,
        damping: 30
      });
    }
  }, [sheetState, sheetY, COLLAPSED_SHEET_Y]);

  // Native TouchEvent handlers to completely own mobile gestures
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    touchCurrentRef.current = { x: touch.clientX, y: touch.clientY };
    lastTouchRef.current = { y: touch.clientY, time: Date.now() };
    axisLockRef.current = null;
    startTimeRef.current = Date.now();
    sheetStartPosRef.current = sheetY.get();
    isDraggingYRef.current = false;
    isGestureReleaseRef.current = false;
    sheetY.stop();

    // Check if touch started inside a scrollable child container (e.g. device list)
    const target = e.target as HTMLElement | null;
    const scrollContainer = target ? target.closest<HTMLElement>('.overflow-y-auto, .overflow-auto, [data-scrollable="true"]') : null;
    if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
      isScrollableStartRef.current = true;
    } else {
      isScrollableStartRef.current = false;
    }
    
    setDragOffsetX(0);
  }, [sheetY]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!touchStartRef.current || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const start = touchStartRef.current;
    
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    
    touchCurrentRef.current = { x: touch.clientX, y: touch.clientY };
    lastTouchRef.current = { y: touch.clientY, time: Date.now() };
    
    const distanceX = Math.abs(deltaX);
    const distanceY = Math.abs(deltaY);
    
    // Determine and lock the dominant axis
    if (axisLockRef.current === null) {
      if (distanceX > 6 || distanceY > 6) {
        if (distanceX > distanceY) {
          axisLockRef.current = "x";
        } else {
          axisLockRef.current = "y";
        }
      }
      return;
    }
    
    if (axisLockRef.current === "y") {
      // If touch started inside a scrollable child container, vertical movement belongs exclusively to that list scroll
      if (isScrollableStartRef.current) {
        return;
      }

      // Once the axis is locked for card sheet drag, prevent default browser window scroll
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      isDraggingYRef.current = true;
      // Dragging vertical bottom-sheet directly from starting point
      const startPos = sheetStartPosRef.current;
      let newY = startPos + deltaY;
      
      // Elastic resistance when dragging past boundaries
      if (newY < 0) {
        newY = newY * 0.2;
      } else if (newY > COLLAPSED_SHEET_Y) {
        const overshoot = newY - COLLAPSED_SHEET_Y;
        newY = COLLAPSED_SHEET_Y + overshoot * 0.2;
      }
      
      sheetY.set(newY);
    } else if (axisLockRef.current === "x") {
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      // Dragging horizontal pages container
      if (mobilePage === 0) {
        setDragOffsetX(Math.min(20, deltaX));
      } else if (mobilePage === 2) {
        setDragOffsetX(Math.max(-20, deltaX));
      } else {
        setDragOffsetX(deltaX);
      }
    }
  }, [mobilePage, sheetY, COLLAPSED_SHEET_Y]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!touchStartRef.current) return;
    
    const start = touchStartRef.current;
    let current = touchCurrentRef.current;
    if (!current && e.changedTouches && e.changedTouches.length > 0) {
      current = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    
    if (!current) {
      setDragOffsetX(0);
      touchStartRef.current = null;
      touchCurrentRef.current = null;
      lastTouchRef.current = null;
      axisLockRef.current = null;
      isScrollableStartRef.current = false;
      isDraggingYRef.current = false;
      return;
    }
    
    const deltaX = current.x - start.x;
    const deltaY = current.y - start.y;
    const duration = Date.now() - startTimeRef.current;
    
    const distanceX = Math.abs(deltaX);
    const distanceY = Math.abs(deltaY);
    
    const velocityX = distanceX / (duration || 1); // px per ms
    const velocityY = distanceY / (duration || 1);
    
    const currentAxis = axisLockRef.current;
    
    if (currentAxis === "y") {
      if (isScrollableStartRef.current) {
        // Gesture belonged to child list scroll, do NOT collapse or expand the card
        setDragOffsetX(0);
        touchStartRef.current = null;
        touchCurrentRef.current = null;
        lastTouchRef.current = null;
        axisLockRef.current = null;
        isScrollableStartRef.current = false;
        isDraggingYRef.current = false;
        return;
      }

      const thresholdY = 35; // responsive snap threshold
      const isFastY = velocityY > 0.15;
      
      let targetState: "expanded" | "compact" = sheetState;
      if (sheetState === "expanded") {
        if (deltaY > thresholdY || (isFastY && deltaY > 0)) {
          targetState = "compact";
        } else {
          targetState = "expanded";
        }
      } else {
        if (deltaY < -thresholdY || (isFastY && deltaY < 0)) {
          targetState = "expanded";
        } else {
          targetState = "compact";
        }
      }
      
      const targetY = targetState === "expanded" ? 0 : COLLAPSED_SHEET_Y;
      
      // Calculate release velocity in px/s, preserving natural gesture momentum
      const now = Date.now();
      const last = lastTouchRef.current || { y: current.y, time: now };
      const timeDiff = Math.max(1, now - last.time);
      const vy = timeDiff > 120 ? 0 : ((current.y - last.y) / timeDiff) * 1000;
      
      isDraggingYRef.current = false;
      isGestureReleaseRef.current = true;
      
      // Animate smoothly from the EXACT current drag position directly to target snap point
      animate(sheetY, targetY, {
        type: "spring",
        stiffness: 300,
        damping: 30,
        velocity: vy
      });
      
      if (targetState !== sheetState) {
        setSheetState(targetState);
      }
    } else if (currentAxis === "x") {
      const thresholdX = 50; // snap threshold
      const isFastX = velocityX > 0.25;
      
      if (deltaX < -thresholdX || (isFastX && deltaX < 0)) {
        if (mobilePage < 2) {
          setMobilePage((prev) => Math.min(2, prev + 1));
        }
      } else if (deltaX > thresholdX || (isFastX && deltaX > 0)) {
        if (mobilePage > 0) {
          setMobilePage((prev) => Math.max(0, prev - 1));
        }
      }
    }
    
    setDragOffsetX(0);
    touchStartRef.current = null;
    touchCurrentRef.current = null;
    lastTouchRef.current = null;
    axisLockRef.current = null;
    isScrollableStartRef.current = false;
  }, [sheetState, mobilePage, sheetY]);

  // Bind non-passive Touch listeners directly to own gestures, ignoring child interference
  useEffect(() => {
    const el = cardContainerRef.current;
    if (!el) return;
    
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [selectedMemberId, isCardHidden, handleTouchStart, handleTouchMove, handleTouchEnd]);

  // Custom Range Draft Values
  const todayStr = useMemo(() => toDateInputValue(new Date()), []);
  const threeDaysAgoStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    return toDateInputValue(d);
  }, []);
  const [draftStartDate, setDraftStartDate] = useState<string>(threeDaysAgoStr);
  const [draftEndDate, setDraftEndDate] = useState<string>(todayStr);
  const [customDateError, setCustomDateError] = useState<string | null>(null);

  const [historyData, setHistoryData] = useState<LocationHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Live ticker for relative last_updated timestamp updates while selected user card is visible
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!selectedMemberId) return;

    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [selectedMemberId]);

  const currentStyleIdRef = useRef<string | null>(null);

  // Filter members that actually have valid, non-null real device locations
  const membersWithLocation = useMemo(() => {
    return members.filter(m => 
      m.devices && m.devices.some(d => isValidCoordinate(d.latitude, d.longitude))
    );
  }, [members]);
  const membersWithLocRef = useRef(membersWithLocation);
  membersWithLocRef.current = membersWithLocation;

  const selectedMember = members.find(m => m.id === selectedMemberId) || null;
  const primaryDevice = selectedMember?.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || selectedMember?.devices?.[0];
  const hasLinkedDevice = Boolean(selectedMember?.devices && selectedMember.devices.length > 0 && primaryDevice);
  const hasValidLocation = Boolean(
    primaryDevice && isValidCoordinate(primaryDevice.latitude, primaryDevice.longitude)
  );

  // Open Google Maps directions to selected family member's latest GPS destination
  const handleGetDirections = useCallback(() => {
    if (
      !primaryDevice ||
      !isValidCoordinate(primaryDevice.latitude, primaryDevice.longitude)
    ) {
      return;
    }

    const lat = primaryDevice.latitude;
    const lng = primaryDevice.longitude;

    // Launch Google Maps app on Android / mobile directly or browser fallback
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    window.open(mapsUrl, "_blank", "noopener,noreferrer");
  }, [primaryDevice]);

  // Ping device: opens device picker and fires targeted Home Assistant 'find_my' event
  const [showDevicePickerModal, setShowDevicePickerModal] = useState(false);
  const [pickerMember, setPickerMember] = useState<CircleMember | null>(null);
  const [pickerDevices, setPickerDevices] = useState<MemberDeviceLocation[]>([]);
  const [selectedDeviceEntityId, setSelectedDeviceEntityId] = useState<string | null>(null);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingStatusMessage, setPingStatusMessage] = useState<string | null>(null);

  const handlePingDevice = useCallback(() => {
    if (!selectedMember || !hasLinkedDevice) return;

    const isSelf = Boolean(
      currentUser && selectedMember && currentUser.id === selectedMember.id
    );

    const allMemberDevices = selectedMember.devices || [];
    const eligibleDevices = allMemberDevices.filter((d) => {
      if (isSelf) return true; // Own devices are ALWAYS available
      return d.allow_find_my_device !== false; // Other member's device MUST have Allow Find My Device = ON
    });

    if (eligibleDevices.length === 0) {
      setPingStatusMessage(`Find My Device is disabled for ${selectedMember.display_name}'s devices.`);
      setTimeout(() => setPingStatusMessage(null), 4500);
      return;
    }

    setPickerMember(selectedMember);
    setPickerDevices(eligibleDevices);
    setSelectedDeviceEntityId(eligibleDevices[0].entity_id);
    setShowDevicePickerModal(true);
  }, [selectedMember, hasLinkedDevice, currentUser]);

  const confirmSendPingDevice = useCallback(async () => {
    if (!pickerMember || !selectedDeviceEntityId) return;

    const targetDevice = pickerDevices.find((d) => d.entity_id === selectedDeviceEntityId);
    if (!targetDevice) return;

    setPingLoading(true);
    setPingStatusMessage(null);

    try {
      const token = localStorage.getItem("token") || "";
      const res = await fetch("/api/events/find_my", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          event_type: "find_my",
          entity_id: targetDevice.entity_id,
          user_id: pickerMember.id,
          device_name: targetDevice.device_name
        })
      });

      setShowDevicePickerModal(false);

      if (res.ok) {
        setPingStatusMessage(`Find My alert sent to ${targetDevice.device_name} (${pickerMember.display_name})`);
      } else if (res.status === 403) {
        setPingStatusMessage("Find My Device is disabled for this member's device.");
      } else {
        const errData = await res.json().catch(() => ({}));
        setPingStatusMessage(errData.detail || `Failed to ping ${targetDevice.device_name}`);
      }
    } catch (err) {
      console.warn("Ping device request error:", err);
      setShowDevicePickerModal(false);
      setPingStatusMessage(`Find My event fired for ${targetDevice.device_name}`);
    } finally {
      setPingLoading(false);
      setTimeout(() => {
        setPingStatusMessage(null);
      }, 4500);
    }
  }, [pickerMember, selectedDeviceEntityId, pickerDevices]);

  // Per-device Ping Action state & handler for Devices page
  const [pingingEntityId, setPingingEntityId] = useState<string | null>(null);
  const [devicePingFeedback, setDevicePingFeedback] = useState<{ entityId: string; message: string; isError?: boolean } | null>(null);

  const handlePingSpecificDevice = useCallback(async (dev: MemberDeviceLocation) => {
    if (!selectedMember || pingingEntityId) return;

    const isSelf = Boolean(currentUser && selectedMember && currentUser.id === selectedMember.id);

    // Only allow logged-in owner to ping their own linked devices
    if (!isSelf) {
      setDevicePingFeedback({
        entityId: dev.entity_id,
        message: "Only device owner can ping this device",
        isError: true
      });
      setTimeout(() => setDevicePingFeedback(null), 3500);
      return;
    }

    setPingingEntityId(dev.entity_id);
    setDevicePingFeedback(null);

    try {
      const token = localStorage.getItem("access_token") || localStorage.getItem("token") || "";
      const res = await fetch("/api/events/find_my", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          event_type: "find_my",
          entity_id: dev.entity_id,
          user_id: selectedMember.id,
          device_name: dev.device_name || dev.entity_id
        })
      });

      if (res.ok) {
        setDevicePingFeedback({
          entityId: dev.entity_id,
          message: `Ping alert sent to ${dev.device_name || dev.entity_id}`,
          isError: false
        });
      } else if (res.status === 403) {
        setDevicePingFeedback({
          entityId: dev.entity_id,
          message: "Ping action disabled for this device",
          isError: true
        });
      } else {
        const errData = await res.json().catch(() => ({}));
        setDevicePingFeedback({
          entityId: dev.entity_id,
          message: errData.detail || `Ping failed for ${dev.device_name || dev.entity_id}`,
          isError: true
        });
      }
    } catch (err) {
      console.warn("Device ping request failed:", err);
      setDevicePingFeedback({
        entityId: dev.entity_id,
        message: "Network error sending ping to Home Assistant",
        isError: true
      });
    } finally {
      setPingingEntityId(null);
      setTimeout(() => {
        setDevicePingFeedback(null);
      }, 3500);
    }
  }, [selectedMember, currentUser, pingingEntityId]);

  // ----------------------------------------------------
  // REVERSE GEOCODING LOGIC
  // ----------------------------------------------------
  const [addressCache, setAddressCache] = useState<Record<string, string>>({});
  const [addressLoading, setAddressLoading] = useState<boolean>(false);

  const currentLat = hasValidLocation && primaryDevice ? primaryDevice.latitude : null;
  const currentLng = hasValidLocation && primaryDevice ? primaryDevice.longitude : null;

  const coordKey = useMemo(() => {
    if (currentLat !== null && currentLng !== null && typeof currentLat === "number" && typeof currentLng === "number") {
      return `${currentLat.toFixed(5)},${currentLng.toFixed(5)}`;
    }
    return null;
  }, [currentLat, currentLng]);

  const currentAddress = coordKey ? addressCache[coordKey] || null : null;

  useEffect(() => {
    if (!coordKey || currentLat === null || currentLng === null) {
      setAddressLoading(false);
      return;
    }

    if (addressCache[coordKey]) {
      setAddressLoading(false);
      return;
    }

    let isMounted = true;
    setAddressLoading(true);

    const fetchAddress = async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentLat}&lon=${currentLng}&zoom=18&addressdetails=1`,
          {
            headers: {
              "Accept-Language": "en"
            }
          }
        );
        if (!res.ok) throw new Error("Reverse geocoding failed");
        const data = await res.json();

        let formattedAddress = "";
        if (data.address) {
          const addr = data.address;
          const houseNum = addr.house_number || addr.building || "";
          const street = addr.road || addr.pedestrian || addr.footway || addr.suburb || addr.neighbourhood || "";
          const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || "";
          const state = addr.state || "";
          const postcode = addr.postcode || "";

          const line1 = [houseNum, street].filter(Boolean).join(" ");
          const line2 = [city, state, postcode].filter(Boolean).join(" ");
          formattedAddress = [line1, line2].filter(Boolean).join(", ");
        }

        if (!formattedAddress && data.display_name) {
          const parts = data.display_name.split(", ").slice(0, 4);
          formattedAddress = parts.join(", ");
        }

        if (isMounted) {
          if (formattedAddress) {
            setAddressCache((prev) => ({ ...prev, [coordKey]: formattedAddress }));
          }
          setAddressLoading(false);
        }
      } catch (err) {
        console.warn("Reverse geocode fetch error:", err);
        if (isMounted) {
          setAddressLoading(false);
        }
      }
    };

    fetchAddress();

    return () => {
      isMounted = false;
    };
  }, [coordKey, currentLat, currentLng, addressCache]);

  // Solid darker route color automatically derived from member's pastel color
  const darkerRouteColor = useMemo(() => {
    return getDarkerRouteColor(selectedMember?.avatar_color);
  }, [selectedMember?.avatar_color]);

  // Retrieve selected member's real location history from Yimly Home Core
  const fetchMemberHistory = useCallback(async (
    memberId: number, 
    range: ActiveRangeConfig
  ) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const token = localStorage.getItem("access_token");
      const queryParams = new URLSearchParams();
      queryParams.set("user_id", String(memberId));
      if (range.type === 'preset') {
        if (range.hours !== undefined && range.hours !== null) {
          queryParams.set("hours", String(range.hours));
        }
      } else if (range.type === 'custom' && range.startDate && range.endDate) {
        queryParams.set("start_date", `${range.startDate}T00:00:00.000Z`);
        queryParams.set("end_date", `${range.endDate}T23:59:59.999Z`);
      }

      const res = await fetch(`/api/history/period?${queryParams.toString()}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });

      if (res.ok) {
        const data: LocationHistoryItem[] = await res.json();
        setHistoryData(data);
      } else {
        const err = await res.json().catch(() => ({ detail: "Failed to load location history" }));
        setHistoryError(err.detail || "Unable to retrieve location history for this member.");
      }
    } catch (err) {
      console.error("Error fetching location history:", err);
      setHistoryError("Network error while communicating with Yimly Core.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Initialize MapLibre GL map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const initialStyleOption = getMapStyle(mapStyle);
    currentStyleIdRef.current = initialStyleOption.id;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: initialStyleOption.style,
      center: [0, 20],
      zoom: 2,
      trackResize: true,
      attributionControl: { compact: false }
    });

    map.on("error", (e: maplibregl.ErrorEvent) => {
      console.error("[MapLibre GL Error]", e);
    });

    const handleUserInteractionStart = (e: maplibregl.MapLibreEvent<MouseEvent | TouchEvent | WheelEvent>) => {
      if (e.originalEvent) {
        // Manual user gesture (drag, pan, zoom gesture) disables auto-follow mode
        isFollowingRef.current = false;
        setIsFollowingState(false);
      }
    };

    map.on("dragstart", () => {
      isFollowingRef.current = false;
      setIsFollowingState(false);
    });

    map.on("movestart", handleUserInteractionStart);

    mapRef.current = map;

    // Set up ResizeObserver to observe the container element
    const resizeObserver = new ResizeObserver(() => {
      if (mapRef.current) {
        mapRef.current.resize();
      }
    });

    resizeObserver.observe(mapContainerRef.current);

    // Initial resize trigger after DOM layout settlement
    const animFrame = requestAnimationFrame(() => {
      map.resize();
    });

    return () => {
      cancelAnimationFrame(animFrame);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
    };
  }, []);

  // Update Map Style dynamically when mapStyle changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const currentStyleOption = getMapStyle(mapStyle);
    if (currentStyleIdRef.current === currentStyleOption.id) return;

    currentStyleIdRef.current = currentStyleOption.id;
    map.setStyle(currentStyleOption.style, { diff: false });
    map.once("styledata", () => {
      map.resize();
    });
  }, [mapStyle]);

  // Sync Smooth Gradient History Route on the Map Canvas with Gap Preservation
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const removeHistoryLayers = () => {
      if (map.getLayer("history-route-points")) map.removeLayer("history-route-points");
      if (map.getLayer("history-route-line")) map.removeLayer("history-route-line");
      if (map.getSource("history-route-source")) map.removeSource("history-route-source");
    };

    // Route is displayed when History is open or historyData is loaded
    const isHistoryActive = isHistoryOpen || historyData.length > 0;

    if (!isHistoryActive || !selectedMemberId || historyData.length === 0) {
      removeHistoryLayers();
      return;
    }

    // Sort chronological ascending (oldest first to draw route progression)
    const validPoints = historyData
      .filter(d => isValidCoordinate(d.latitude, d.longitude))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (validPoints.length === 0) {
      removeHistoryLayers();
      return;
    }

    const totalPoints = validPoints.length;
    const geojsonFeatures: GeoJSON.Feature[] = [];

    // Build contiguous 2-point LineString segments with smooth gradient coloring
    // preserving gaps (> 6 hours or > 50km without recorded points)
    for (let i = 1; i < totalPoints; i++) {
      const prevPt = validPoints[i - 1];
      const currPt = validPoints[i];

      const timeDiffHours = Math.abs(new Date(currPt.timestamp).getTime() - new Date(prevPt.timestamp).getTime()) / (3600 * 1000);
      const distKm = calculateDistanceKm(prevPt.latitude, prevPt.longitude, currPt.latitude, currPt.longitude);

      // Do NOT invent paths across large gaps in recorded history
      if (timeDiffHours > 6 || distKm > 50) {
        continue;
      }

      // Progress along chronological journey: oldest is 0.0 (lightest), newest is 1.0 (darkest)
      const segmentProgress = totalPoints > 1 ? (i - 0.5) / (totalPoints - 1) : 1.0;
      const segmentColor = getRouteGradientColor(selectedMember?.avatar_color, segmentProgress);

      geojsonFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [prevPt.longitude, prevPt.latitude],
            [currPt.longitude, currPt.latitude]
          ]
        },
        properties: {
          color: segmentColor
        }
      });
    }

    // Add individual waypoint circles with matching gradient color
    validPoints.forEach((pt, idx) => {
      const ptProgress = totalPoints > 1 ? idx / (totalPoints - 1) : 1.0;
      const ptColor = getRouteGradientColor(selectedMember?.avatar_color, ptProgress);

      geojsonFeatures.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [pt.longitude, pt.latitude]
        },
        properties: {
          color: ptColor,
          isLatest: idx === totalPoints - 1
        }
      });
    });

    const geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: geojsonFeatures
    };

    try {
      const existingSource = map.getSource("history-route-source") as maplibregl.GeoJSONSource;
      if (existingSource) {
        existingSource.setData(geojson);
        if (map.getLayer("history-route-line")) {
          map.setPaintProperty("history-route-line", "line-color", ["get", "color"]);
        }
        if (map.getLayer("history-route-points")) {
          map.setPaintProperty("history-route-points", "circle-color", ["get", "color"]);
        }
      } else {
        map.addSource("history-route-source", {
          type: "geojson",
          data: geojson
        });

        // Gradient route line segments with rounded joins and caps
        map.addLayer({
          id: "history-route-line",
          type: "line",
          source: "history-route-source",
          filter: ["==", "$type", "LineString"],
          layout: {
            "line-join": "round",
            "line-cap": "round"
          },
          paint: {
            "line-color": ["get", "color"],
            "line-width": 4.5,
            "line-opacity": 0.95
          }
        });

        // Waypoint circles along gradient
        map.addLayer({
          id: "history-route-points",
          type: "circle",
          source: "history-route-source",
          filter: ["==", "$type", "Point"],
          paint: {
            "circle-radius": 5,
            "circle-color": ["get", "color"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff"
          }
        });
      }
    } catch (err) {
      console.warn("History layer update deferred until style data is ready:", err);
    }
  }, [isHistoryOpen, selectedMemberId, historyData, selectedMember?.avatar_color, mapStyle]);

  // Custom Map Actions
  const handleZoomIn = () => {
    mapRef.current?.zoomIn();
  };

  const handleZoomOut = () => {
    mapRef.current?.zoomOut();
  };

  const handleFitBounds = useCallback(() => {
    const map = mapRef.current;
    if (!map || membersWithLocation.length === 0) return;

    setIsFollowing(false);

    if (membersWithLocation.length === 1) {
      const primaryDevice = membersWithLocation[0].devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || membersWithLocation[0].devices?.[0];
      if (primaryDevice && isValidCoordinate(primaryDevice.latitude, primaryDevice.longitude)) {
        map.flyTo({
          center: [primaryDevice.longitude, primaryDevice.latitude],
          zoom: 15,
          padding: { top: 76, bottom: 28, left: 0, right: 0 },
          duration: 800
        });
      }
    } else {
      const bounds = new maplibregl.LngLatBounds();
      membersWithLocation.forEach((m) => {
        m.devices?.forEach((d) => {
          if (isValidCoordinate(d.latitude, d.longitude)) {
            bounds.extend([d.longitude, d.latitude]);
          }
        });
      });

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 800 });
      }
    }

    setSelectedMemberId(null);
    setIsHistoryOpen(false);
    setIsCustomRangeActive(false);
    setHistoryData([]);
    setIsCardHidden(false);
    navMemberHistoryRef.current = [];
  }, [membersWithLocation, setSelectedMemberId, setIsFollowing]);

  // Card-aware bottom padding calculation
  const getBottomPadding = useCallback((isHidden: boolean) => {
    if (isHidden) return 28;
    if (cardContainerRef.current) {
      const rect = cardContainerRef.current.getBoundingClientRect();
      const measured = window.innerHeight - rect.top + 16;
      if (measured > 80 && measured < window.innerHeight * 0.65) return measured;
    }
    return isHistoryOpen ? 210 : 155;
  }, [isHistoryOpen]);

  // Directly fly map camera to clicked member's current real coordinates
  const flyToMemberLocation = useCallback((
    member: CircleMember,
    isHidden: boolean = false,
    duration = 800
  ) => {
    const dev = member.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || member.devices?.[0];
    if (!dev || !isValidCoordinate(dev.latitude, dev.longitude)) return;
    const map = mapRef.current;
    if (!map) return;

    const bottomPad = getBottomPadding(isHidden);
    const topPad = 76;

    // Direct target coordinate tracking (avoid stale React state)
    currentTargetCoordRef.current = [dev.longitude, dev.latitude];

    const currentZoom = map.getZoom();
    const targetZoom = currentZoom < 14 ? 15 : currentZoom;

    map.flyTo({
      center: [dev.longitude, dev.latitude],
      zoom: targetZoom,
      padding: { top: topPad, bottom: bottomPad, left: 0, right: 0 },
      duration,
      essential: true
    });
  }, [getBottomPadding]);

  // Directly fly map camera to a specific device's exact GPS coordinates
  const flyToDeviceLocation = useCallback((
    latitude: number | null | undefined,
    longitude: number | null | undefined,
    duration = 800
  ) => {
    if (!isValidCoordinate(latitude, longitude)) return;
    const map = mapRef.current;
    if (!map) return;

    const bottomPad = getBottomPadding(isCardHidden);
    const topPad = 76;

    currentTargetCoordRef.current = [longitude!, latitude!];

    const currentZoom = map.getZoom();
    const targetZoom = currentZoom < 14 ? 15 : currentZoom;

    map.flyTo({
      center: [longitude!, latitude!],
      zoom: targetZoom,
      padding: { top: topPad, bottom: bottomPad, left: 0, right: 0 },
      duration,
      essential: true
    });
  }, [getBottomPadding, isCardHidden]);

  // Focus member, center map in usable area above card, and show member information card
  const handleFocusMember = useCallback((memberOrId: CircleMember | number) => {
    const memberId = typeof memberOrId === "number" ? memberOrId : memberOrId.id;
    const targetMember = 
      membersWithLocRef.current.find(m => m.id === memberId) || 
      members.find(m => m.id === memberId) || 
      (typeof memberOrId !== "number" ? memberOrId : null);

    if (!targetMember) return;

    if (selectedMemberId && selectedMemberId !== targetMember.id) {
      navMemberHistoryRef.current.push(selectedMemberId);
    }
    setSelectedMemberId(targetMember.id);
    setIsFollowing(true);
    setCustomDateError(null);
    setIsCardHidden(false);
    setSheetState("expanded");
    setMobilePage(0);

    const dev = targetMember.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || targetMember.devices?.[0];
    if (dev && isValidCoordinate(dev.latitude, dev.longitude)) {
      lastFollowedCoordRef.current = { lat: dev.latitude, lng: dev.longitude };
    }

    // Direct flyTo using clicked member's current coordinates
    flyToMemberLocation(targetMember, false, 800);
    if (isHistoryOpen) {
      fetchMemberHistory(targetMember.id, activeRange);
    }
  }, [selectedMemberId, members, isHistoryOpen, activeRange, fetchMemberHistory, flyToMemberLocation, setSelectedMemberId, setIsFollowing]);

  // Recenter map on the currently selected member's valid location without changing selection
  const handleRecenterSelectedMember = useCallback(() => {
    if (!selectedMember) return;
    const dev = selectedMember.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || selectedMember.devices?.[0];
    if (!dev || !isValidCoordinate(dev.latitude, dev.longitude)) return;

    setIsFollowing(true);
    lastFollowedCoordRef.current = { lat: dev.latitude, lng: dev.longitude };
    flyToMemberLocation(selectedMember, isCardHidden, 800);
  }, [selectedMember, flyToMemberLocation, isCardHidden, setIsFollowing]);

  useImperativeHandle(ref, () => ({
    focusMember: handleFocusMember
  }), [handleFocusMember]);

  // Synchronise external propSelectedMemberId with internal selection state
  useEffect(() => {
    if (propSelectedMemberId !== undefined && propSelectedMemberId !== internalSelectedMemberId) {
      if (propSelectedMemberId === null) {
        setInternalSelectedMemberId(null);
        setIsFollowing(false);
      } else {
        const member = members.find(m => m.id === propSelectedMemberId);
        if (member) {
          setInternalSelectedMemberId(propSelectedMemberId);
          setIsFollowing(true);
          setIsCardHidden(false);
          const dev = member.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || member.devices?.[0];
          if (dev && isValidCoordinate(dev.latitude, dev.longitude)) {
            lastFollowedCoordRef.current = { lat: dev.latitude, lng: dev.longitude };
          }
          const timer = setTimeout(() => {
            flyToMemberLocation(member, false, 800);
          }, 50);
          if (isHistoryOpen) {
            fetchMemberHistory(member.id, activeRange);
          }
          return () => clearTimeout(timer);
        }
      }
    }
  }, [propSelectedMemberId, internalSelectedMemberId, members, flyToMemberLocation, isHistoryOpen, activeRange, fetchMemberHistory, setIsFollowing]);

  // Follow Mode: Smoothly move map camera when selected member receives new valid GPS location updates
  useEffect(() => {
    if (!isFollowingRef.current || !selectedMemberId || isCardHidden) return;

    const map = mapRef.current;
    if (!map) return;

    const dev = selectedMember?.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || selectedMember?.devices?.[0];
    if (!dev || !isValidCoordinate(dev.latitude, dev.longitude)) return;

    const last = lastFollowedCoordRef.current;
    if (last && last.lat === dev.latitude && last.lng === dev.longitude) {
      return; // No position change
    }

    lastFollowedCoordRef.current = { lat: dev.latitude, lng: dev.longitude };

    const bottomPad = getBottomPadding(isCardHidden);
    const topPad = 76;

    currentTargetCoordRef.current = [dev.longitude, dev.latitude];

    const currentZoom = map.getZoom();
    const targetZoom = currentZoom < 14 ? 15 : currentZoom;

    map.easeTo({
      center: [dev.longitude, dev.latitude],
      zoom: targetZoom,
      padding: { top: topPad, bottom: bottomPad, left: 0, right: 0 },
      duration: 800,
      essential: true
    });
  }, [selectedMember, selectedMemberId, isCardHidden, getBottomPadding]);

  // Show Card action: restores card and re-centers member in usable area above card
  const handleShowCard = useCallback(() => {
    setIsCardHidden(false);
    if (selectedMember) {
      flyToMemberLocation(selectedMember, false, 400);
    }
  }, [selectedMember, flyToMemberLocation]);

  // Hide Card action: hides card and expands usable map area to full viewport
  const handleSetDefaultDevice = useCallback(async (entityId: string) => {
    if (!selectedMember) return;
    try {
      if (onSetDefaultDevice) {
        onSetDefaultDevice(selectedMember.id, entityId);
      }

      const token = localStorage.getItem("access_token");
      if (token) {
        await fetch(`/api/devices/${encodeURIComponent(entityId)}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ is_default: true })
        });
      }

      if (onRefresh) {
        onRefresh();
      }
    } catch (err) {
      console.error("Failed to update default device:", err);
    }
  }, [selectedMember, onSetDefaultDevice, onRefresh]);

  const handleHideCard = useCallback(() => {
    setIsCardHidden(true);
    if (selectedMember) {
      const dev = selectedMember.devices?.find(d => d.latitude !== null && d.longitude !== null);
      if (dev && dev.longitude !== null && dev.latitude !== null && mapRef.current) {
        mapRef.current.easeTo({
          center: [dev.longitude, dev.latitude],
          padding: { top: 76, bottom: 28, left: 0, right: 0 },
          duration: 350
        });
      }
    }
  }, [selectedMember]);

  // Back button navigation: returns to previous state without losing map state
  const handleNavBack = useCallback(() => {
    if (isCustomRangeActive) {
      setIsCustomRangeActive(false);
      setCustomDateError(null);
      return;
    }
    if (isHistoryOpen) {
      setIsHistoryOpen(false);
      return;
    }
    if (navMemberHistoryRef.current.length > 0) {
      const prevId = navMemberHistoryRef.current.pop();
      if (prevId) {
        const prevMember = membersWithLocRef.current.find(m => m.id === prevId);
        if (prevMember) {
          setSelectedMemberId(prevId);
          flyToMemberLocation(prevMember, false, 600);
          return;
        }
      }
    }
    // Return to general map view
    setSelectedMemberId(null);
    setIsHistoryOpen(false);
    setIsCustomRangeActive(false);
    setHistoryData([]);
  }, [isCustomRangeActive, isHistoryOpen, flyToMemberLocation]);

  // Close Card action
  const handleCloseCard = useCallback(() => {
    setSelectedMemberId(null);
    setIsFollowing(false);
    setIsHistoryOpen(false);
    setIsCustomRangeActive(false);
    setHistoryData([]);
    setIsCardHidden(false);
    currentTargetCoordRef.current = null;
    navMemberHistoryRef.current = [];
  }, [setSelectedMemberId, setIsFollowing]);

  // Toggle History control within card
  const handleToggleHistory = useCallback(() => {
    if (!selectedMember) return;
    const nextOpen = !isHistoryOpen;
    setIsHistoryOpen(nextOpen);
    if (nextOpen) {
      fetchMemberHistory(selectedMember.id, activeRange);
    }
  }, [selectedMember, isHistoryOpen, activeRange, fetchMemberHistory]);

  // Select Date Range Preset (Today | Week | Month | Custom)
  const handleSelectRange = useCallback((rangeOption: 'today' | 'week' | 'month' | 'custom') => {
    if (!selectedMember) return;
    if (rangeOption === 'custom') {
      setIsCustomRangeActive(true);
      setDraftStartDate(activeRange.startDate || threeDaysAgoStr);
      setDraftEndDate(activeRange.endDate || todayStr);
      return;
    }
    setIsCustomRangeActive(false);
    let hours = 24;
    let label = "Today";
    if (rangeOption === 'week') {
      hours = 168;
      label = "Week";
    } else if (rangeOption === 'month') {
      hours = 720;
      label = "Month";
    }
    const newRange: ActiveRangeConfig = {
      type: 'preset',
      presetId: rangeOption,
      hours,
      label
    };
    setActiveRange(newRange);
    fetchMemberHistory(selectedMember.id, newRange);
  }, [selectedMember, activeRange, threeDaysAgoStr, todayStr, fetchMemberHistory]);

  // Apply Custom Date Range
  const handleApplyCustomRange = useCallback(() => {
    if (!selectedMember) return;
    if (!draftStartDate || !draftEndDate) {
      setCustomDateError("Please select both start and end dates.");
      return;
    }
    if (draftStartDate > draftEndDate) {
      setCustomDateError("Start date cannot be after End date.");
      return;
    }
    const customLabel = formatCustomRangeLabel(draftStartDate, draftEndDate);
    const newRange: ActiveRangeConfig = {
      type: 'custom',
      startDate: draftStartDate,
      endDate: draftEndDate,
      label: customLabel
    };
    setActiveRange(newRange);
    setCustomDateError(null);
    fetchMemberHistory(selectedMember.id, newRange);
  }, [selectedMember, draftStartDate, draftEndDate, fetchMemberHistory]);

  // Post-layout camera adjustment: when card finishes rendering or changes dimensions,
  // ensure the selected member is visually centered in the usable map area ABOVE the bottom card
  useEffect(() => {
    if (!cardContainerRef.current || !selectedMemberId || isCardHidden) return;

    const observer = new ResizeObserver(() => {
      const map = mapRef.current;
      const targetCoord = currentTargetCoordRef.current;
      if (!map || !targetCoord) return;

      // Do NOT interrupt active flyTo animations during initial selection!
      if (map.isMoving()) return;

      const rect = cardContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const actualBottomPad = Math.max(80, Math.min(window.innerHeight * 0.65, window.innerHeight - rect.top + 16));

      map.easeTo({
        center: targetCoord,
        padding: { top: 76, bottom: actualBottomPad, left: 0, right: 0 },
        duration: 200
      });
    });

    observer.observe(cardContainerRef.current);
    return () => observer.disconnect();
  }, [selectedMemberId, isHistoryOpen, isCustomRangeActive, isCardHidden]);

  // Viewport-tracking state to trigger re-renders on pan/zoom/resize
  const [indicatorTrigger, setIndicatorTrigger] = useState(0);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleUpdate = () => {
      setIndicatorTrigger((prev) => prev + 1);
    };

    map.on("move", handleUpdate);
    map.on("zoom", handleUpdate);
    map.on("resize", handleUpdate);
    window.addEventListener("resize", handleUpdate);

    return () => {
      map.off("move", handleUpdate);
      map.off("zoom", handleUpdate);
      map.off("resize", handleUpdate);
      window.removeEventListener("resize", handleUpdate);
    };
  }, []);

  // Update Markers & Sync Selection (with individual balloon markers fanning out for same-location members)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // 1. Group members by screen proximity (30px threshold based on visible rendered screen distance)
    const container = map.getContainer();
    const screenCenterX = container ? container.clientWidth / 2 : window.innerWidth / 2;
    const screenCenterY = container ? container.clientHeight / 2 : window.innerHeight / 2;

    interface MemberScreenData {
      member: CircleMember;
      primaryDevice: MemberDeviceLocation;
      screenPoint: { x: number; y: number };
      distToCenter: number;
    }

    const validMembers: MemberScreenData[] = [];
    membersWithLocation.forEach((member) => {
      const primaryDevice = member.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || member.devices?.[0];
      if (!primaryDevice || !isValidCoordinate(primaryDevice.latitude, primaryDevice.longitude)) return;
      try {
        const screenPoint = map.project([primaryDevice.longitude, primaryDevice.latitude]);
        const distToCenter = Math.hypot(screenPoint.x - screenCenterX, screenPoint.y - screenCenterY);
        validMembers.push({ member, primaryDevice, screenPoint, distToCenter });
      } catch {
        validMembers.push({
          member,
          primaryDevice,
          screenPoint: { x: screenCenterX, y: screenCenterY },
          distToCenter: 0
        });
      }
    });

    interface MemberCluster {
      members: CircleMember[];
      minDistToCenter: number;
    }

    const clusters: MemberCluster[] = [];

    validMembers.forEach((item) => {
      let matchedCluster: MemberCluster | null = null;

      for (const cluster of clusters) {
        // Within 30px screen distance of any member in this cluster
        const isWithin30px = cluster.members.some((m) => {
          const mDev = m.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || m.devices?.[0];
          if (!mDev || !isValidCoordinate(mDev.latitude, mDev.longitude)) return false;
          try {
            const p = map.project([mDev.longitude, mDev.latitude]);
            return Math.hypot(item.screenPoint.x - p.x, item.screenPoint.y - p.y) <= 30;
          } catch {
            return false;
          }
        });

        if (isWithin30px) {
          matchedCluster = cluster;
          break;
        }
      }

      if (matchedCluster) {
        matchedCluster.members.push(item.member);
        matchedCluster.minDistToCenter = Math.min(matchedCluster.minDistToCenter, item.distToCenter);
      } else {
        clusters.push({
          members: [item.member],
          minDistToCenter: item.distToCenter
        });
      }
    });

    // Find the cluster (individual or stacked group) closest to the center of the visible map/screen
    let closestClusterIndex = 0;
    let minCenterDist = Infinity;

    clusters.forEach((cluster, cIdx) => {
      if (cluster.minDistToCenter < minCenterDist) {
        minCenterDist = cluster.minDistToCenter;
        closestClusterIndex = cIdx;
      }
    });

    const currentMarkerKeys = new Set<string>();

    clusters.forEach((cluster, cIdx) => {
      const clusterCount = cluster.members.length;
      const isClusterPrimary = clusters.length === 1 || cIdx === closestClusterIndex;
      const activePinType = mapPinType || "classic_pin";

      const unselBase = typeof unselectedIconSize === "number" && unselectedIconSize > 0 ? unselectedIconSize : 64;
      const selBase = typeof selectedIconSize === "number" && selectedIconSize > 0 ? selectedIconSize : 72;

      const stackedMembers: StackedMemberInfo[] = cluster.members.map((m) => {
        const pDev = m.devices?.[0];
        const devIcon = pDev?.map_icon ? pDev.map_icon.split(" ")[0] : "📱";
        const batt = pDev?.battery !== undefined && pDev?.battery !== null ? pDev.battery : null;
        return {
          id: m.id,
          memberName: m.display_name,
          baseColor: getAvatarColor(m.avatar_color),
          photoUrl: m.profile_picture_url || null,
          deviceIcon: devIcon,
          batteryLevel: batt
        };
      });

      cluster.members.forEach((member, idx) => {
        const primaryDevice = member.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || member.devices?.[0];
        if (!primaryDevice || !isValidCoordinate(primaryDevice.latitude, primaryDevice.longitude)) return;

        const markerKey = `member_${member.id}`;
        currentMarkerKeys.add(markerKey);

        const isSelected = selectedMemberId === member.id;
        const baseSize = isSelected ? selBase : unselBase;
        const dims = getMarkerDimensions(activePinType, baseSize);

        // Geographically anchored to exact GPS coordinates
        const markerLng = primaryDevice.longitude;
        const markerLat = primaryDevice.latitude;

        // Layering: selected gets 100, primary (closest to center) gets 60-69, others tiered by distance
        let markerZIndex = isSelected
          ? 100
          : isClusterPrimary
          ? 60 + idx
          : Math.max(10, 40 - Math.min(25, Math.floor(cluster.minDistToCenter / 30))) + idx;

        let marker = markersRef.current[markerKey];

        if (!marker) {
          const el = document.createElement("div");
          el.className = "custom-member-marker cursor-pointer select-none";
          el.style.zIndex = String(markerZIndex);

          marker = new maplibregl.Marker({
            element: el,
            anchor: dims.anchor,
            offset: [0, 0]
          })
            .setLngLat([markerLng, markerLat])
            .addTo(map);

          markersRef.current[markerKey] = marker;
        } else {
          marker.setLngLat([markerLng, markerLat]);
          marker.setOffset([0, 0]);
        }

        const el = marker.getElement();
        el.style.zIndex = String(markerZIndex);
        el.style.width = `${dims.width}px`;
        el.style.height = `${dims.height}px`;

        // Direct tap on member's individual marker
        el.onclick = (e) => {
          e.stopPropagation();
          const freshMember = membersWithLocRef.current.find((m) => m.id === member.id) || member;
          handleFocusMember(freshMember);
        };

        const baseColor = getAvatarColor(member.avatar_color);
        const deviceIcon = primaryDevice.map_icon ? primaryDevice.map_icon.split(" ")[0] : "📱";
        const batteryVal = primaryDevice.battery !== undefined && primaryDevice.battery !== null ? primaryDevice.battery : null;
        const photoUrl = member.profile_picture_url || "";
        const memberName = member.display_name;

        const stackFingerprint = cluster.members.map((m) => `${m.id}_${getAvatarColor(m.avatar_color)}_${m.profile_picture_url || ""}`).join("|");
        const renderKey = `${markerKey}_${activePinType}_${isSelected}_${dims.width}_${dims.height}_${baseColor}_${photoUrl}_${memberName}_${deviceIcon}_${batteryVal}_${isClusterPrimary}_${stackFingerprint}`;

        if (el.dataset.renderKey !== renderKey) {
          el.dataset.renderKey = renderKey;
          el.innerHTML = renderMarkerHTML({
            pinType: activePinType,
            baseColor,
            isSelected,
            size: baseSize,
            photoUrl,
            memberName,
            deviceIcon,
            batteryLevel: batteryVal,
            showBattery: true,
            isPrimary: isClusterPrimary,
            stackedMembers: clusterCount > 1 ? stackedMembers : undefined
          });
        }
      });
    });

    // Render Private Device Markers for logged-in user's non-default devices ONLY
    const loggedInOwner = membersWithLocation.find((m) => currentUser && m.id === currentUser.id);
    if (loggedInOwner && loggedInOwner.devices && loggedInOwner.devices.length > 1) {
      const privateDevices = loggedInOwner.devices.slice(1);
      const ownerColor = getAvatarColor(loggedInOwner.avatar_color);

      privateDevices.forEach((dev) => {
        if (!isValidCoordinate(dev.latitude, dev.longitude)) return;

        const pMarkerKey = `private_device_${dev.entity_id}`;
        currentMarkerKeys.add(pMarkerKey);

        const markerLng = dev.longitude;
        const markerLat = dev.latitude;

        let pMarker = markersRef.current[pMarkerKey];

        if (!pMarker) {
          const el = document.createElement("div");
          el.className = "custom-private-device-marker cursor-pointer select-none";
          el.style.zIndex = "55";

          pMarker = new maplibregl.Marker({
            element: el,
            anchor: "center",
            offset: [0, 0]
          })
            .setLngLat([markerLng, markerLat])
            .addTo(map);

          markersRef.current[pMarkerKey] = pMarker;
        } else {
          pMarker.setLngLat([markerLng, markerLat]);
          pMarker.setOffset([0, 0]);
        }

        const el = pMarker.getElement();
        el.style.zIndex = "55";
        el.style.width = "34px";
        el.style.height = "34px";

        el.onclick = (e) => {
          e.stopPropagation();
          map.flyTo({ center: [markerLng, markerLat], zoom: 16, duration: 500 });
          handleFocusMember(loggedInOwner);
        };

        const mapIcon = dev.map_icon ? dev.map_icon.split(" ")[0] : "📱";
        const devName = dev.device_name || "Private Device";
        const pRenderKey = `${pMarkerKey}_${ownerColor}_${mapIcon}_${devName}_34`;

        if (el.dataset.renderKey !== pRenderKey) {
          el.dataset.renderKey = pRenderKey;
          el.innerHTML = renderPrivateDeviceMarkerHTML({
            ownerColor,
            deviceIcon: mapIcon,
            deviceName: devName
          });
        }
      });
    }

    // Cleanup markers for removed members
    Object.keys(markersRef.current).forEach((key) => {
      if (!currentMarkerKeys.has(key)) {
        markersRef.current[key].remove();
        delete markersRef.current[key];
      }
    });

    // Auto-fit initial bounds when markers first load if nothing is selected
    if (selectedMemberId === null && membersWithLocation.length > 0 && map.getZoom() <= 2) {
      if (membersWithLocation.length === 1) {
        const pDev = membersWithLocation[0].devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || membersWithLocation[0].devices?.[0];
        if (pDev && isValidCoordinate(pDev.latitude, pDev.longitude)) {
          map.flyTo({ center: [pDev.longitude, pDev.latitude], zoom: 15, duration: 800 });
        }
      } else {
        const bounds = new maplibregl.LngLatBounds();
        membersWithLocation.forEach((m) => {
          m.devices?.forEach((d) => {
            if (isValidCoordinate(d.latitude, d.longitude)) {
              bounds.extend([d.longitude, d.latitude]);
            }
          });
        });

        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 80, maxZoom: 16 });
        }
      }
    }
  }, [membersWithLocation, selectedMemberId, selectedIconSize, unselectedIconSize, handleFocusMember, mapPinType, indicatorTrigger]);

  // Update Places Markers & Geofence Circles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Filter valid places according to safety rules
    const validPlaces = (places || []).filter(isValidPlace);

    const openPlacePopup = (place: Place) => {
      if (activePlacePopupRef.current) {
        activePlacePopupRef.current.remove();
        activePlacePopupRef.current = null;
      }

      const svgContent = getPlaceIconSVGString(place.icon);

      const popupContent = `
        <div class="p-3 bg-slate-900/95 backdrop-blur-xl text-white rounded-2xl shadow-2xl border border-slate-700/80 min-w-[200px] font-sans">
          <div class="flex items-center gap-2.5 mb-2 pb-2 border-b border-slate-800">
            <div class="w-8 h-8 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0 border border-indigo-500/30">
              <svg class="w-4.5 h-4.5 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                ${svgContent}
              </svg>
            </div>
            <div class="font-extrabold text-sm text-slate-100 truncate">${escapeHtml(place.name)}</div>
          </div>
          ${
            place.address
              ? `<div class="text-xs text-slate-300 mb-2 flex items-start gap-1.5"><span class="shrink-0 text-indigo-400">📍</span><span class="leading-tight">${escapeHtml(
                  place.address
                )}</span></div>`
              : ""
          }
          <div class="text-[11px] font-bold text-indigo-300 flex items-center gap-1.5 bg-indigo-950/80 px-2.5 py-1 rounded-lg border border-indigo-800/50 w-fit">
            <span class="text-indigo-400">⭕</span>
            <span>Geofence:</span>
            <span class="text-white">${
              place.radius >= 1000 ? (place.radius / 1000).toFixed(1) + " km" : place.radius + " m"
            }</span>
          </div>
        </div>
      `;

      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        className: "custom-place-popup",
        offset: [0, -10]
      })
        .setLngLat([place.longitude, place.latitude])
        .setHTML(popupContent)
        .addTo(map);

      activePlacePopupRef.current = popup;
    };

    // 1. Update GeoJSON source & layers for geofence circles
    const circleFeatures = validPlaces.map((place) =>
      createGeoJSONCircle([place.longitude, place.latitude], place.radius, 64, {
        id: place.id,
        name: place.name
      })
    );

    const geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: circleFeatures
    };

    const syncCircleSourceAndLayers = () => {
      try {
        const source = map.getSource("places-geofence-source") as maplibregl.GeoJSONSource;
        if (source) {
          source.setData(geojson);
        } else {
          map.addSource("places-geofence-source", {
            type: "geojson",
            data: geojson
          });

          // Fill layer
          map.addLayer({
            id: "places-geofence-fill",
            type: "fill",
            source: "places-geofence-source",
            paint: {
              "fill-color": "#6366f1",
              "fill-opacity": 0.15
            }
          });

          // Outline stroke layer
          map.addLayer({
            id: "places-geofence-stroke",
            type: "line",
            source: "places-geofence-source",
            paint: {
              "line-color": "#4f46e5",
              "line-width": 2,
              "line-dasharray": [2, 2],
              "line-opacity": 0.7
            }
          });
        }
      } catch (err) {
        console.warn("Places geofence layer update deferred until style ready:", err);
      }
    };

    if (map.isStyleLoaded()) {
      syncCircleSourceAndLayers();
    } else {
      map.once("styledata", syncCircleSourceAndLayers);
    }

    // 2. Sync Place DOM Markers
    const currentPlaceMarkerKeys = new Set<string>();

    validPlaces.forEach((place) => {
      const markerKey = `place_${place.id}`;
      currentPlaceMarkerKeys.add(markerKey);

      let marker = markersRef.current[markerKey];

      if (!marker) {
        const el = document.createElement("div");
        el.className = "custom-place-marker cursor-pointer select-none";
        el.style.zIndex = "45"; // below member markers (60-100)

        marker = new maplibregl.Marker({
          element: el,
          anchor: "center",
          offset: [0, 0]
        })
          .setLngLat([place.longitude, place.latitude])
          .addTo(map);

        markersRef.current[markerKey] = marker;
      } else {
        marker.setLngLat([place.longitude, place.latitude]);
      }

      const el = marker.getElement();
      el.style.zIndex = "45";

      el.onclick = (e) => {
        e.stopPropagation();
        openPlacePopup(place);
      };

      const renderKey = `${markerKey}_${place.name}_${place.icon || "map-pin"}_${place.latitude}_${place.longitude}_${place.radius}_${place.address || ""}`;

      if (el.dataset.renderKey !== renderKey) {
        el.dataset.renderKey = renderKey;
        el.innerHTML = renderPlaceMarkerHTML({
          name: place.name,
          icon: place.icon,
          radius: place.radius
        });
      }
    });

    // 3. Remove markers for deleted/removed places
    Object.keys(markersRef.current).forEach((key) => {
      if (key.startsWith("place_") && !currentPlaceMarkerKeys.has(key)) {
        markersRef.current[key].remove();
        delete markersRef.current[key];
      }
    });
  }, [places, mapStyle]);

  const renderOffScreenIndicators = () => {
    const map = mapRef.current;
    if (!map) return null;

    let container;
    try {
      container = map.getContainer();
    } catch (err) {
      return null;
    }
    if (!container) return null;

    const W = container.clientWidth;
    const H = container.clientHeight;

    // Left/right indicators use previous horizontal margin (24px) to clear UI buttons,
    // while top and bottom boundaries remain at the full visible screen viewport (0 and H).
    const leftMargin = 24;
    const rightMargin = 24;
    const minX = leftMargin;
    const maxX = W - rightMargin;
    const minY = 0;
    const maxY = H;

    if (maxX <= minX || maxY <= minY) return null;

    const cx = W / 2;
    const cy = H / 2;

    const offScreenMembers: Array<{
      member: CircleMember;
      px: number;
      py: number;
      x: number;
      y: number;
      edge: "top" | "bottom" | "left" | "right";
      angleDeg: number;
      baseSize: number;
      baseColor: string;
      batteryVal: number | string | null;
      primaryDevice: any;
      s: number;
    }> = [];

    membersWithLocation.forEach((member) => {
      const primaryDevice = member.devices?.find(d => isValidCoordinate(d.latitude, d.longitude)) || member.devices?.[0];
      if (!primaryDevice || !isValidCoordinate(primaryDevice.latitude, primaryDevice.longitude)) return;

      // MapLibre project coordinates onto screen space
      const screenPos = map.project([primaryDevice.longitude, primaryDevice.latitude]);
      const px = screenPos.x;
      const py = screenPos.y;

      // Treat as off-screen if outside our safe bounds (e.g. hidden by sheet, navigation, or edges)
      const isOffScreen = px < minX || px > maxX || py < minY || py > maxY;

      if (isOffScreen) {
        // Find clipping boundary intersection coordinate
        let { x, y, edge } = getIntersectionPoint(cx, cy, px, py, minX, maxX, minY, maxY);

        // TOP/BOTTOM edge + horizontal position → hang LEFT or RIGHT based on which side the member is closer to
        if (edge === "top" || edge === "bottom") {
          const hangLeft = px < cx;
          if (hangLeft) {
            edge = "left";
            x = minX;
          } else {
            edge = "right";
            x = maxX;
          }
        }

        // Calculate direction angle from viewport center to target coordinate
        const angleRad = Math.atan2(py - cy, px - cx);
        const angleDeg = (angleRad * 180) / Math.PI;

        const baseColor = getAvatarColor(member.avatar_color);
        const batteryVal = primaryDevice.battery !== undefined && primaryDevice.battery !== null ? primaryDevice.battery : null;

        // Map intersection coordinate onto continuous 1D perimeter
        const w = maxX - minX;
        const h = maxY - minY;
        let s = 0;
        if (edge === "right") {
          s = w + (y - minY);
        } else {
          s = 2 * w + h + (maxY - y);
        }

        offScreenMembers.push({
          member,
          px,
          py,
          x,
          y,
          edge,
          angleDeg,
          baseSize: 40,
          baseColor,
          batteryVal,
          primaryDevice,
          s,
        });
      }
    });

    if (offScreenMembers.length === 0) return null;

    // Resolve Overlap Collisions along the perimeter using standard push-apart iterations
    const L = 2 * (maxX - minX) + 2 * (maxY - minY);
    const minDistance = 54; // Keep icons spaced perfectly

    for (let iter = 0; iter < 8; iter++) {
      offScreenMembers.sort((a, b) => a.s - b.s);
      let changed = false;
      for (let i = 0; i < offScreenMembers.length; i++) {
        const current = offScreenMembers[i];
        const next = offScreenMembers[(i + 1) % offScreenMembers.length];

        // Only resolve collisions between indicators sharing the same edge (left or right)
        if (current.edge !== next.edge) continue;

        let diff = next.s - current.s;
        if (diff < 0) diff += L;

        if (diff < minDistance) {
          const overlap = minDistance - diff;
          current.s = (current.s - overlap / 2 + L) % L;
          next.s = (next.s + overlap / 2) % L;
          // Clamp to stay strictly on their respective vertical edge
          const w = maxX - minX;
          const h = maxY - minY;
          if (current.edge === "right") {
            current.s = Math.max(w, Math.min(w + h, current.s));
            next.s = Math.max(w, Math.min(w + h, next.s));
          } else {
            current.s = Math.max(2 * w + h, Math.min(2 * w + 2 * h, current.s));
            next.s = Math.max(2 * w + h, Math.min(2 * w + 2 * h, next.s));
          }
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Convert resolved 1D perimeter coordinates back to 2D screen positions and apply smart scaling
    const indicators = offScreenMembers
      .map((item) => {
        const { x, y, edge } = getCoordsFromPerimeter(item.s, minX, maxX, minY, maxY);

        // Distance to closest corner for corner safe compression (vertical edges)
        const distanceToCorner = Math.min(y - minY, maxY - y);

        // Smooth viewport scale based on client width
        const viewportFactor = Math.min(1, Math.max(0, (W - 375) / (1200 - 375)));
        let baseSize = 34 + viewportFactor * 10; // 34px on phone, scales gracefully to 44px on tablet/desktop

        // Corner safe sizing: reduce slightly near corners so indicator fits perfectly without clipping
        const cornerSpace = 44;
        if (distanceToCorner < cornerSpace) {
          const ratio = 0.78 + 0.22 * (distanceToCorner / cornerSpace); // Minimum scale limit of 78%
          baseSize *= ratio;
        }

        return {
          ...item,
          x,
          y,
          edge,
          baseSize,
        };
      })
      .filter((item) => item.edge === "left" || item.edge === "right");

    if (indicators.length === 0) return null;

    return (
      <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
        {indicators.map(({ member, x, y, angleDeg, baseSize, baseColor, batteryVal, primaryDevice }) => {
          const batteryScale = baseSize / 40;
          return (
            <button
              key={`offscreen_${member.id}`}
              onClick={(e) => {
                e.stopPropagation();
                handleFocusMember(member);
              }}
              className="absolute pointer-events-auto cursor-pointer focus:outline-none transition-transform active:scale-95 group"
              style={{
                left: `${x}px`,
                top: `${y}px`,
                transform: "translate(-50%, -50%)",
              }}
              title={`Center on ${member.display_name}`}
            >
              {/* Pointing pointer wrapper */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ transform: `rotate(${angleDeg}deg)` }}
              >
                <svg
                  className="absolute w-3.5 h-3.5 text-white transition-transform group-hover:scale-110"
                  viewBox="0 0 10 10"
                  style={{
                    left: `calc(50% + ${baseSize / 2 - 1.5}px)`,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  <polygon
                    points="0,1.5 8,5 0,8.5"
                    fill={baseColor}
                    stroke="white"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>

              {/* Squircle member badge with custom SVG device icon */}
              <div
                className="relative flex items-center justify-center transition-all duration-150"
                style={{
                  width: `${baseSize}px`,
                  height: `${baseSize}px`,
                  filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.15))",
                }}
              >
                {/* Layer 1: Colored Border Shell */}
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{
                    backgroundColor: baseColor,
                    clipPath: "url(#squircle-clip-map)"
                  }}
                >
                  {/* Layer 2: White Spacer Layer */}
                  <div
                    className="absolute inset-[1.5px] bg-white flex items-center justify-center"
                    style={{ clipPath: "url(#squircle-clip-map)" }}
                  >
                    {/* Layer 3: Inner Background & Profile Picture */}
                    <div
                      className="absolute inset-[1.5px] text-white font-black flex items-center justify-center overflow-hidden"
                      style={{
                        backgroundColor: baseColor,
                        clipPath: "url(#squircle-clip-map)"
                      }}
                    >
                      {member.profile_picture_url ? (
                        <img
                          src={member.profile_picture_url}
                          alt={member.display_name}
                          className="w-full h-full object-cover pointer-events-none"
                          style={{ clipPath: "url(#squircle-clip-map)" }}
                        />
                      ) : (
                        <span className="text-white font-black select-none" style={{ fontSize: `${baseSize * 0.32}px` }}>
                          {member.display_name.charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Single source of truth custom DeviceIcon SVG inside badge */}
                <div
                  className="absolute -bottom-1 -left-1 bg-white rounded-full shadow-xs border border-slate-100/80 flex items-center justify-center text-indigo-600"
                  style={{
                    width: `${baseSize * 0.44}px`,
                    height: `${baseSize * 0.44}px`,
                  }}
                >
                  <DeviceIcon
                    deviceIcon={primaryDevice.map_icon}
                    className="w-[60%] h-[60%] text-indigo-600"
                  />
                </div>

                {/* Proportionally scaling battery level indicator */}
                {batteryVal !== null && (
                  <div
                    className="absolute -top-1 -right-1 bg-white text-slate-800 font-extrabold px-1 rounded-full shadow-xs border border-slate-200/90 flex items-center gap-0.5 pointer-events-none"
                    style={{
                      fontSize: "8px",
                      lineHeight: "10px",
                      height: "12px",
                      transform: `scale(${batteryScale}) translate(10%, -10%)`,
                      transformOrigin: "top right",
                    }}
                    title={`Battery: ${batteryVal}%`}
                  >
                    <span
                      className={`w-1 h-1 rounded-full ${
                        Number(batteryVal) <= 20 ? "bg-rose-500 animate-pulse" : "bg-emerald-500"
                      }`}
                    />
                    <span>{batteryVal}%</span>
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="relative w-full h-full overflow-hidden select-none">
      {/* SVG Definitions for true mathematical squircle clips */}
      <svg className="absolute w-0 h-0 pointer-events-none" width="0" height="0">
        <defs>
          <clipPath id="squircle-clip-map" clipPathUnits="objectBoundingBox">
            <path d="M 0.5,0 C 0.86,0 1,0.14 1,0.5 C 1,0.86 0.86,1 0.5,1 C 0.14,1 0,0.86 0,0.5 C 0,0.14 0.14,0 0.5,0 Z" />
          </clipPath>
        </defs>
      </svg>
      
      {/* FULL-SCREEN MAP CANVAS */}
      <div ref={mapContainerRef} className="w-full h-full absolute inset-0 z-0 bg-[#f8fafc]" />
      
      {/* ADAPTIVE OFF-SCREEN MEMBER INDICATORS */}
      {renderOffScreenIndicators()}



      {/* FLOATING MAP CONTROLS (RIGHT SIDEBAR) */}
      <div className="absolute right-3 sm:right-4 top-16 sm:top-20 z-20 pointer-events-auto flex flex-col gap-2.5">
        <div className="bg-white/85 backdrop-blur-2xl p-1 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.08)] border border-white/80 flex flex-col gap-1">
          <button
            onClick={handleZoomIn}
            className="w-9 h-9 rounded-xl hover:bg-slate-100/90 active:scale-95 flex items-center justify-center text-slate-700 hover:text-indigo-600 transition-all duration-150 cursor-pointer"
            title="Zoom In"
            aria-label="Zoom In"
          >
            <Plus className="w-4 h-4" />
          </button>

          <div className="w-6 h-px bg-slate-200/60 mx-auto" />

          <button
            onClick={handleZoomOut}
            className="w-9 h-9 rounded-xl hover:bg-slate-100/90 active:scale-95 flex items-center justify-center text-slate-700 hover:text-indigo-600 transition-all duration-150 cursor-pointer"
            title="Zoom Out"
            aria-label="Zoom Out"
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={handleFitBounds}
          className="w-11 h-11 bg-white/85 backdrop-blur-2xl rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.08)] border border-white/80 flex items-center justify-center text-slate-700 hover:text-indigo-600 hover:bg-white active:scale-95 transition-all duration-150 cursor-pointer"
          title="Recenter / Fit All"
          aria-label="Recenter / Fit All"
        >
          <Navigation className="w-4.5 h-4.5" />
        </button>

        <button
          onClick={onRefresh}
          disabled={loading}
          className="w-11 h-11 bg-white/85 backdrop-blur-2xl rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.08)] border border-white/80 flex items-center justify-center text-slate-700 hover:text-indigo-600 hover:bg-white active:scale-95 transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          title="Refresh Locations"
          aria-label="Refresh Locations"
        >
          <RefreshCw className={`w-4.5 h-4.5 ${loading ? "animate-spin text-indigo-600" : ""}`} />
        </button>
      </div>

      {/* UNIVERSAL SELECTED-MEMBER BOTTOM SHEET CARD (MASTER PHONE UI FOR ALL DEVICES) */}
      {selectedMember && !isCardHidden && (
        <motion.div
          ref={cardContainerRef}
          className="fixed bottom-[-24px] left-3 right-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[480px] sm:max-w-[calc(100vw-1.5rem)] h-[430px] z-30 pointer-events-auto select-none touch-none"
          style={{
            y: sheetY
          }}
        >
          <div className="w-full h-full bg-white/85 backdrop-blur-2xl border-t border-x border-white/80 shadow-[0_-12px_40px_rgba(0,0,0,0.08)] rounded-t-[32px] overflow-hidden relative z-10 pt-2 pb-8">
            {/* Centered Drag Handle / Tap to expand-collapse */}
            <div
              onClick={() => setSheetState(sheetState === "expanded" ? "compact" : "expanded")}
              className="w-full pt-1 pb-2 cursor-pointer flex justify-center items-center select-none animate-pulse-slow"
              title="Drag or tap to resize"
            >
              <div className="w-12 h-1 bg-slate-300/80 rounded-full hover:bg-slate-400 transition" />
            </div>

            {/* Draggable/Swipeable Content Pages Container (Always rendered for fluid animations, clipped via parent overflow) */}
            <div className="w-full h-[330px] overflow-hidden relative">
              <motion.div
                animate={{
                  x: `calc(${-mobilePage * (100 / 3)}% + ${dragOffsetX}px)`
                }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="flex w-[300%] h-full"
              >
                {/* PAGE 1: Current Info */}
                <div className="w-1/3 h-full px-5 pb-4 flex flex-col justify-between overflow-y-auto scrollbar-none select-none">
                  <div className="space-y-3">
                    {/* Member Name */}
                    <div
                      onClick={() => {
                        if (sheetState === "compact") {
                          setSheetState("expanded");
                        }
                      }}
                      className="cursor-pointer select-none py-1 -my-1"
                      title={sheetState === "compact" ? "Swipe up or tap to expand" : undefined}
                    >
                      <h3 className="text-lg font-black text-slate-800 text-center leading-tight">
                        {selectedMember.display_name}
                      </h3>
                    </div>

                  {hasLinkedDevice ? (
                    <>
                      {/* Last Known Location & Address Block */}
                      <div className="bg-slate-50/90 border border-slate-100 rounded-2xl p-2.5 text-center space-y-1">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-extrabold uppercase tracking-wider justify-center">
                          <MapPin className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                          <span>Last known location</span>
                        </div>

                        {hasValidLocation && primaryDevice ? (
                          <>
                            {/* Primary: Reverse Geocoded Street Address */}
                            <div className="text-xs sm:text-sm font-extrabold text-slate-800 leading-snug px-1">
                              {addressLoading && !currentAddress ? (
                                <span className="text-slate-400 font-medium italic">Resolving address...</span>
                              ) : currentAddress ? (
                                currentAddress
                              ) : (
                                `${primaryDevice.latitude.toFixed(6)}, ${primaryDevice.longitude.toFixed(6)}`
                              )}
                            </div>

                            {/* Secondary: Exact GPS Coordinates */}
                            <div className="text-[11px] font-mono font-semibold text-slate-500 tracking-wide">
                              {primaryDevice.latitude.toFixed(6)}, {primaryDevice.longitude.toFixed(6)}
                            </div>
                          </>
                        ) : (
                          <div className="text-xs text-slate-500 font-medium">Location unavailable</div>
                        )}
                      </div>

                      {/* Battery Status */}
                      <div className="flex items-center justify-center gap-1.5 text-xs text-slate-500 font-bold">
                        {primaryDevice?.charging ? (
                          <BatteryCharging className="w-4 h-4 text-emerald-500 shrink-0 animate-pulse" />
                        ) : (
                          <Battery className="w-4 h-4 text-emerald-500 shrink-0" />
                        )}
                        <span>
                          Battery {primaryDevice?.battery !== undefined && primaryDevice?.battery !== null ? `${primaryDevice.battery}%` : "100%"}
                          {primaryDevice?.charging ? " (Charging)" : ""}
                        </span>
                      </div>

                      {/* Ping Device Status Toast / Banner */}
                      {pingStatusMessage && (
                        <div className="flex items-center justify-center gap-2 py-2 px-3 bg-amber-500/15 border border-amber-500/30 text-amber-900 rounded-xl text-xs font-extrabold animate-in fade-in duration-200 text-center shadow-2xs">
                          <Volume2 className="w-4 h-4 text-amber-600 animate-pulse shrink-0" />
                          <span>{pingStatusMessage}</span>
                        </div>
                      )}

                      {/* Action Buttons in Mobile Sheet (Recenter, Get Directions & Ping Device) */}
                      <div className="pt-1 flex items-center justify-center gap-1.5 px-1">
                        <button
                          type="button"
                          onClick={handleRecenterSelectedMember}
                          disabled={!hasValidLocation}
                          className="flex-1 py-2.5 px-2 bg-indigo-600 hover:bg-indigo-700 active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-black transition flex items-center justify-center gap-1 shadow-xs cursor-pointer"
                          title={hasValidLocation ? "Recenter map on selected member" : "Location unavailable to recenter"}
                          aria-label="Recenter Selected Member"
                        >
                          <Navigation className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">Recenter</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleGetDirections}
                          disabled={!hasValidLocation}
                          className="flex-1 py-2.5 px-2 bg-emerald-600 hover:bg-emerald-700 active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-black transition flex items-center justify-center gap-1 shadow-xs cursor-pointer"
                          title={hasValidLocation ? "Get directions in Google Maps" : "Location unavailable for directions"}
                          aria-label="Get Directions in Google Maps"
                        >
                          <Route className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">Directions</span>
                        </button>

                        <button
                          type="button"
                          onClick={handlePingDevice}
                          disabled={!hasLinkedDevice || pingLoading}
                          className="flex-1 py-2.5 px-2 bg-amber-500 hover:bg-amber-600 active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-black transition flex items-center justify-center gap-1 shadow-xs cursor-pointer"
                          title="Ping device (plays sound via Home Assistant find_my event)"
                          aria-label="Ping Device"
                        >
                          <Volume2 className={`w-3.5 h-3.5 shrink-0 ${pingLoading ? "animate-bounce" : ""}`} />
                          <span className="truncate">{pingLoading ? "Pinging..." : "Ping"}</span>
                        </button>
                      </div>

                      {/* Divider and Preset History Controls */}
                      <div className="border-t border-slate-100/80 pt-3">
                        <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2 text-center">
                          History
                        </h4>
                        <div className="flex items-center gap-2 px-1">
                          {(['today', 'week', 'month'] as const).map((opt) => {
                            const isSelected = activeRange.type === 'preset' && activeRange.presetId === opt;
                            const labels: Record<string, string> = {
                              today: 'Today',
                              week: 'Week',
                              month: 'Month'
                            };
                            return (
                              <button
                                key={opt}
                                type="button"
                                onClick={() => {
                                  handleSelectRange(opt);
                                  if (!isHistoryOpen) {
                                    // Make sure trail gets opened immediately
                                    setIsHistoryOpen(true);
                                  }
                                }}
                                className={`flex-1 py-2 rounded-xl text-xs font-black transition cursor-pointer active:scale-95 text-center ${
                                  isSelected
                                    ? "bg-indigo-600 text-white shadow-xs"
                                    : "bg-slate-100 hover:bg-slate-200/80 text-slate-600 hover:text-slate-900"
                                }`}
                              >
                                {labels[opt]}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="mt-4 p-4 rounded-2xl bg-white/40 border border-white/60 text-center">
                      <p className="text-xs font-bold text-slate-700 leading-relaxed">
                        No GPS device linked to this account
                      </p>
                    </div>
                  )}
                </div>

                {/* Page Indicator 1 */}
                <div className="flex items-center justify-center gap-1.5 mt-2 pb-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
                  <button
                    onClick={() => setMobilePage(1)}
                    className="w-1.5 h-1.5 rounded-full bg-slate-300 hover:bg-slate-400 transition"
                    aria-label="Go to Custom Range page"
                  />
                  <button
                    onClick={() => setMobilePage(2)}
                    className="w-1.5 h-1.5 rounded-full bg-slate-300 hover:bg-slate-400 transition"
                    aria-label="Go to Devices page"
                  />
                </div>
              </div>

              {/* PAGE 2: Custom Range */}
              <div className="w-1/3 h-full px-5 pb-4 flex flex-col justify-between overflow-y-auto scrollbar-none select-none">
                <div className="space-y-4">
                  <h3 className="text-base font-black text-slate-800 text-center mt-1">
                    Custom Range
                  </h3>

                  <div className="space-y-3 px-1">
                    {/* Start Date */}
                    <div className="space-y-1 text-left">
                      <label className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                        Start
                      </label>
                      <input
                        type="date"
                        value={draftStartDate}
                        onChange={(e) => {
                          setDraftStartDate(e.target.value);
                          setCustomDateError(null);
                        }}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200/60 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                      />
                    </div>

                    {/* End Date */}
                    <div className="space-y-1 text-left">
                      <label className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                        End
                      </label>
                      <input
                        type="date"
                        value={draftEndDate}
                        onChange={(e) => {
                          setDraftEndDate(e.target.value);
                          setCustomDateError(null);
                        }}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200/60 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                      />
                    </div>

                    {customDateError && (
                      <div className="text-[10px] font-bold text-rose-500 text-center">
                        {customDateError}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        handleApplyCustomRange();
                        if (!isHistoryOpen) {
                          setIsHistoryOpen(true);
                        }
                      }}
                      className="w-full mt-2 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-xs font-black transition shadow-xs cursor-pointer"
                    >
                      Apply
                    </button>
                  </div>
                </div>

                {/* Page Indicator 2 */}
                <div className="flex items-center justify-center gap-1.5 mt-2 pb-2">
                  <button
                    onClick={() => setMobilePage(0)}
                    className="w-1.5 h-1.5 rounded-full bg-slate-300 hover:bg-slate-400 transition"
                    aria-label="Go to Current Info page"
                  />
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
                  <button
                    onClick={() => setMobilePage(2)}
                    className="w-1.5 h-1.5 rounded-full bg-slate-300 hover:bg-slate-400 transition"
                    aria-label="Go to Devices page"
                  />
                </div>
              </div>

              {/* PAGE 3: Linked Devices */}
              <div className="w-1/3 h-full px-5 pb-4 flex flex-col justify-between overflow-hidden select-none">
                <div className="space-y-3">
                  <h3 className="text-base font-black text-slate-800 text-center mt-1">
                    Linked Devices
                  </h3>

                  {selectedMember.devices && selectedMember.devices.length > 0 ? (
                    <div data-scrollable="true" className="space-y-2 max-h-[220px] overflow-y-auto overscroll-y-contain pr-0.5 scrollbar-thin">
                      {selectedMember.devices.map((dev, devIdx) => {
                        const isDefault = dev.is_default || devIdx === 0;
                        const isOwner = currentUser && String(selectedMember.id) === String(currentUser.id);
                        const hasLoc = dev.latitude !== null && dev.longitude !== null;

                        return (
                          <div
                            key={dev.entity_id}
                            onClick={() => flyToDeviceLocation(dev.latitude, dev.longitude)}
                            className={`p-3 rounded-2xl border text-left transition ${
                              hasLoc ? "cursor-pointer hover:border-indigo-300 hover:shadow-2xs active:scale-[0.99]" : ""
                            } ${
                              isDefault
                                ? "bg-indigo-50/80 border-indigo-200/90 shadow-2xs"
                                : "bg-slate-50/80 border-slate-200/60"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-8 h-8 rounded-xl bg-white border border-slate-200/80 flex items-center justify-center text-indigo-600 shrink-0 shadow-2xs">
                                  <DeviceIcon deviceIcon={dev.map_icon} deviceName={dev.device_name} className="w-4 h-4 text-indigo-600" />
                                </div>
                                <div className="min-w-0">
                                  <h4 className="text-xs font-black text-slate-800 truncate">
                                    {dev.device_name || dev.entity_id}
                                  </h4>
                                  <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5">
                                    {dev.battery !== undefined && dev.battery !== null && (
                                      <span className="flex items-center gap-0.5 font-bold text-slate-600">
                                        {dev.charging ? (
                                          <BatteryCharging className="w-3 h-3 text-emerald-500 animate-pulse" />
                                        ) : (
                                          <Battery className="w-3 h-3 text-emerald-500" />
                                        )}
                                        {dev.battery}%
                                      </span>
                                    )}
                                    <span>•</span>
                                    <span>{formatRelativeLastUpdated(dev.last_updated, nowMs)}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                {isOwner && (
                                  <button
                                    type="button"
                                    disabled={pingingEntityId === dev.entity_id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handlePingSpecificDevice(dev);
                                    }}
                                    className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 active:scale-95 text-amber-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-full transition cursor-pointer flex items-center gap-1 text-[10px] font-extrabold border border-amber-500/25 shrink-0"
                                    title="Ping device (plays sound/notification via Home Assistant)"
                                    aria-label="Ping Device"
                                  >
                                    <Volume2 className={`w-3 h-3 text-amber-600 ${pingingEntityId === dev.entity_id ? "animate-bounce" : ""}`} />
                                    <span>{pingingEntityId === dev.entity_id ? "Pinging..." : "Ping"}</span>
                                  </button>
                                )}

                                {isDefault ? (
                                  <span className="px-2.5 py-1 bg-indigo-100 text-indigo-700 text-[10px] font-black rounded-full flex items-center gap-1 shrink-0">
                                    <Check className="w-3 h-3 text-indigo-600" /> Default
                                  </span>
                                ) : isOwner ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSetDefaultDevice(dev.entity_id);
                                    }}
                                    className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-[10px] font-bold rounded-full transition cursor-pointer shrink-0 shadow-2xs"
                                  >
                                    Set as Default
                                  </button>
                                ) : (
                                  <span className="px-2.5 py-1 bg-slate-200/80 text-slate-600 text-[10px] font-extrabold rounded-full shrink-0">
                                    Private
                                  </span>
                                )}
                              </div>
                            </div>

                            {dev.latitude !== null && dev.longitude !== null && (
                              <div className="mt-2 pt-2 border-t border-slate-200/50 flex items-center justify-between text-[10px] text-slate-400 font-mono">
                                <span className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-indigo-500" /> Exact Location
                                </span>
                                <span>{dev.latitude.toFixed(5)}, {dev.longitude.toFixed(5)}</span>
                              </div>
                            )}

                            {devicePingFeedback?.entityId === dev.entity_id && (
                              <div className={`mt-2 p-1.5 rounded-xl text-[10px] font-bold text-center animate-in fade-in duration-200 ${
                                devicePingFeedback.isError
                                  ? "bg-rose-50 text-rose-700 border border-rose-200/60"
                                  : "bg-emerald-50 text-emerald-700 border border-emerald-200/60"
                              }`}>
                                {devicePingFeedback.message}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-6 px-4 rounded-2xl bg-slate-50/80 border border-slate-200/60 text-center">
                      <p className="text-xs font-bold text-slate-600">
                        No GPS devices connected
                      </p>
                    </div>
                  )}
                </div>

                {/* Page Indicator 3 */}
                <div className="flex items-center justify-center gap-1.5 mt-2 pb-2">
                  <button
                    onClick={() => setMobilePage(0)}
                    className="w-1.5 h-1.5 rounded-full bg-slate-300 hover:bg-slate-400 transition"
                    aria-label="Go to Current Info page"
                  />
                  <button
                    onClick={() => setMobilePage(1)}
                    className="w-1.5 h-1.5 rounded-full bg-slate-300 hover:bg-slate-400 transition"
                    aria-label="Go to Custom Range page"
                  />
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </motion.div>
    )}

      {/* 4. REOPEN / SHOW CARD FLOATING BUTTON (WHEN TEMPORARILY COLLAPSED) */}
      {selectedMember && isCardHidden && (
        <div className="absolute bottom-20 md:bottom-22 left-4 md:left-6 z-30 pointer-events-auto animate-in fade-in slide-in-from-bottom-2 duration-200">
          <button
            onClick={handleShowCard}
            className="w-10 h-10 sm:w-11 sm:h-11 bg-white/90 backdrop-blur-2xl rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-white/80 flex items-center justify-center text-slate-700 hover:text-indigo-600 hover:bg-white transition cursor-pointer"
            title="Show card"
            aria-label="Show card"
          >
            <ChevronUp className="w-4.5 h-4.5" />
          </button>
        </div>
      )}

      {/* NO FAKE LOCATIONS EMPTY STATE FLOATING OVERLAY */}
      {membersWithLocation.length === 0 && selectedMember === null && (
        <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center p-4">
          <div className="bg-white/90 backdrop-blur-2xl p-7 rounded-3xl shadow-2xl border border-white/80 pointer-events-auto text-center max-w-sm">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3.5 mx-auto shadow-sm border border-indigo-100/40">
              <MapPin className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-slate-800">No device locations available</h3>
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed font-semibold">
              Locations will automatically appear when family members configure Traccar Client and send real coordinates.
            </p>

            <div className="mt-4 p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100 text-left">
              <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Connection steps:</h4>
              <ul className="mt-2 space-y-1 text-[10px] text-slate-400 list-disc list-inside font-semibold">
                <li>Install Traccar Client app</li>
                <li>Configure Server URL & Device ID (Settings → Devices)</li>
                <li>Start tracking to stream location telemetry</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* DEVICE PICKER MODAL FOR TARGETED FIND_MY PING */}
      {showDevicePickerModal && pickerMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative space-y-4">
            <button
              type="button"
              onClick={() => setShowDevicePickerModal(false)}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-amber-50 text-amber-600 border border-amber-200/60 flex items-center justify-center shrink-0">
                <Volume2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-extrabold text-slate-800">Ping Device</h3>
                <p className="text-xs text-slate-400 font-medium">Select target device for {pickerMember.display_name}</p>
              </div>
            </div>

            <div className="space-y-2 max-h-60 overflow-y-auto py-1">
              {pickerDevices.map((dev) => {
                const isSelected = selectedDeviceEntityId === dev.entity_id;
                return (
                  <button
                    key={dev.entity_id}
                    type="button"
                    onClick={() => setSelectedDeviceEntityId(dev.entity_id)}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-2xl border text-left transition cursor-pointer ${
                      isSelected
                        ? "bg-amber-50/70 border-amber-400 text-slate-900 shadow-2xs font-bold"
                        : "bg-slate-50/60 border-slate-200/80 text-slate-700 hover:bg-slate-100/70"
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      isSelected ? "border-amber-600 bg-amber-600" : "border-slate-300 bg-white"
                    }`}>
                      {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>

                    <div className="w-9 h-9 rounded-xl bg-indigo-50/80 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0 shadow-2xs">
                      <DeviceIcon deviceIcon={dev.map_icon} deviceName={dev.device_name} className="w-4.5 h-4.5 text-indigo-600" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-extrabold truncate text-slate-800">{dev.device_name}</div>
                      <div className="text-[10px] text-slate-400 font-medium flex items-center gap-1.5 mt-0.5">
                        <span>{dev.platform || "Android"}</span>
                        <span>•</span>
                        <span>Battery: {dev.battery !== undefined && dev.battery !== null ? `${dev.battery}%` : "100%"}</span>
                      </div>
                      <div className="text-[9px] text-slate-400/80 font-mono truncate mt-0.5">{dev.entity_id}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDevicePickerModal(false)}
                className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl text-xs font-bold transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedDeviceEntityId || pingLoading}
                onClick={confirmSendPingDevice}
                className="px-4 py-2.5 bg-amber-500 hover:bg-amber-600 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-2xl text-xs font-extrabold transition shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Volume2 className={`w-4 h-4 ${pingLoading ? "animate-bounce" : ""}`} />
                <span>{pingLoading ? "Sending..." : "Ping Selected Device"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
});
