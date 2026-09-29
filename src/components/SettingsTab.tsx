import React, { useEffect, useState, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { UserInfo, Circle, UserDevice } from "../types";
import { MAP_STYLES } from "../lib/mapStyles";
import { MapLivePreview } from "./MapLivePreview";
import { QRScannerModal } from "./QRScannerModal";
import { DeviceIcon } from "./DeviceIcon";
import { DEFAULT_AVATAR_COLOR, getAvatarColor, isValidHexColor, normalizeHexColor } from "../lib/avatarColor";
import {
  User,
  Users,
  Map as MapIcon,
  Clock,
  Bell,
  Smartphone,
  ChevronDown,
  ChevronUp,
  Check,
  Upload,
  Trash2,
  Camera,
  RefreshCw,
  AlertCircle,
  LogOut,
  X,
  KeyRound,
  Eye,
  EyeOff,
  Copy,
  PlusCircle,
  LogIn,
  Sliders,
  Shield,
  Radio,
  Edit2
} from "lucide-react";

interface SettingsTabProps {
  user: UserInfo | null;
  onLogout: () => void;
  onClose?: () => void;
  onUserUpdate?: (updated: UserInfo) => void;
  circles?: Circle[];
  selectedCircle?: Circle | null;
  onSelectCircle?: (circle: Circle) => void;
  onCreateCircle?: (name: string) => Promise<void>;
  onJoinCircle?: (code: string) => Promise<void>;
  onLeaveCircle?: (circleId: number) => Promise<void>;
  onDeleteCircle?: (circleId: number) => Promise<void>;
  circlesLoading?: boolean;
}

const ACCOUNT_COLOUR_PRESETS = [
  { name: "Pastel Red", hex: "#FF9AA2" },
  { name: "Pastel Orange", hex: "#FFB347" },
  { name: "Pastel Yellow", hex: "#FDFF8F" },
  { name: "Pastel Green", hex: "#A8E6CF" },
  { name: "Pastel Cyan", hex: "#A8ECE7" },
  { name: "Pastel Blue", hex: "#B8B5FF" },
  { name: "Pastel Purple", hex: "#D47AE8" }
];

const isValidHex = (hex: string): boolean => {
  return /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex.trim());
};

const normalizeHex = (hex: string): string => {
  let clean = hex.trim();
  if (!clean.startsWith("#")) {
    clean = "#" + clean;
  }
  if (clean.length === 4) {
    clean = `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  return clean.toUpperCase();
};

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  let cleaned = hex.replace("#", "").trim();
  if (cleaned.length === 3) {
    cleaned = cleaned.split("").map((c) => c + c).join("");
  }
  if (cleaned.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
    return { h: 0, s: 1, v: 1 };
  }

  const r = parseInt(cleaned.substring(0, 2), 16) / 255;
  const g = parseInt(cleaned.substring(2, 4), 16) / 255;
  const b = parseInt(cleaned.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : d / max;
  const v = max;

  return { h, s, v };
}

function hsvToHex(h: number, s: number, v: number): string {
  s = Math.max(0, Math.min(1, s));
  v = Math.max(0, Math.min(1, v));
  h = (h % 360 + 360) % 360;

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;

  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  const toHex = (n: number) => {
    const val = Math.round((n + m) * 255);
    return Math.max(0, Math.min(255, val)).toString(16).padStart(2, "0");
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

interface CustomColorPickerPopoverProps {
  color: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onChange: (newHex: string) => void;
  onClose: () => void;
}

const CustomColorPickerPopover: React.FC<CustomColorPickerPopoverProps> = ({
  color,
  anchorRef,
  onChange,
  onClose
}) => {
  const satValRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const [hsv, setHsv] = useState<{ h: number; s: number; v: number }>(() => hexToHsv(color));
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  useEffect(() => {
    if (isValidHex(color)) {
      const normalized = normalizeHex(color);
      const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);
      if (normalized !== currentHex) {
        setHsv(hexToHsv(color));
      }
    }
  }, [color]);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();

    const popoverWidth = popoverRef.current?.offsetWidth || 270;
    const popoverHeight = popoverRef.current?.offsetHeight || 290;
    const margin = 12;

    // Vertical positioning: default below button, flip above if overflowing bottom
    let top = rect.bottom + 8;
    if (top + popoverHeight > window.innerHeight - margin && rect.top - popoverHeight - 8 > margin) {
      top = rect.top - popoverHeight - 8;
    }
    // Clamp top to stay within viewport
    top = Math.max(margin, Math.min(top, window.innerHeight - popoverHeight - margin));

    // Horizontal positioning: align right edge of popover with button right edge if fits, else left edge
    let left = rect.right - popoverWidth;
    if (left < margin) {
      left = rect.left;
    }
    // Strictly clamp left so popover is always within [margin, window.innerWidth - popoverWidth - margin]
    const maxLeft = Math.max(margin, window.innerWidth - popoverWidth - margin);
    left = Math.max(margin, Math.min(left, maxLeft));

    setCoords({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    updatePosition();
    const handleScrollOrResize = () => updatePosition();
    window.addEventListener("resize", handleScrollOrResize);
    window.addEventListener("scroll", handleScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("scroll", handleScrollOrResize, true);
    };
  }, [updatePosition]);

  const updateSatVal = (clientX: number, clientY: number) => {
    if (!satValRef.current) return;
    const rect = satValRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

    const s = x / rect.width;
    const v = 1 - y / rect.height;

    const nextHsv = { ...hsv, s, v };
    setHsv(nextHsv);
    const newHex = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
    onChange(newHex);
  };

  const handleSatValPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateSatVal(e.clientX, e.clientY);
  };

  const handleSatValPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1 || e.currentTarget.hasPointerCapture(e.pointerId)) {
      updateSatVal(e.clientX, e.clientY);
    }
  };

  const handleSatValPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const updateHue = (clientX: number) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));

    const h = Math.round((x / rect.width) * 360);

    const nextHsv = { ...hsv, h };
    setHsv(nextHsv);
    const newHex = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
    onChange(newHex);
  };

  const handleHuePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateHue(e.clientX);
  };

  const handleHuePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1 || e.currentTarget.hasPointerCapture(e.pointerId)) {
      updateHue(e.clientX);
    }
  };

  const handleHuePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998] bg-black/0 cursor-default"
        onClick={onClose}
      />
      <div
        ref={popoverRef}
        id="custom-color-picker-popover"
        className="fixed z-[9999] w-[270px] max-w-[calc(100vw-24px)] p-3.5 bg-white/95 backdrop-blur-xl border border-slate-200/90 rounded-2xl shadow-2xl space-y-3 select-none transition-opacity duration-100"
        style={{
          top: `${coords.top}px`,
          left: `${coords.left}px`,
          opacity: coords.top === -9999 ? 0 : 1
        }}
      >
        <div className="flex items-center justify-between text-xs font-bold text-slate-700">
          <span>Custom Colour</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition cursor-pointer"
            title="Close colour picker"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 2D Saturation / Value Canvas Area */}
        <div
          ref={satValRef}
          onPointerDown={handleSatValPointerDown}
          onPointerMove={handleSatValPointerMove}
          onPointerUp={handleSatValPointerUp}
          className="relative w-full h-32 rounded-xl cursor-crosshair overflow-hidden touch-none shadow-inner border border-slate-200/80"
          style={{
            backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
            backgroundImage: `
              linear-gradient(to top, #000, transparent),
              linear-gradient(to right, #fff, transparent)
            `,
          }}
        >
          <div
            className="absolute w-4.5 h-4.5 -ml-2.25 -mt-2.25 rounded-full border-2 border-white shadow-md pointer-events-none transition-transform active:scale-125"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
              backgroundColor: currentHex,
            }}
          />
        </div>

        {/* 1D Hue Spectrum Slider */}
        <div className="space-y-1">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Hue</div>
          <div
            ref={hueRef}
            onPointerDown={handleHuePointerDown}
            onPointerMove={handleHuePointerMove}
            onPointerUp={handleHuePointerUp}
            className="relative w-full h-4 rounded-full cursor-pointer touch-none shadow-inner border border-slate-200/80 overflow-hidden"
            style={{
              background: `linear-gradient(to right, 
                #ff0000 0%, 
                #ffff00 17%, 
                #00ff00 33%, 
                #00ffff 50%, 
                #0000ff 67%, 
                #ff00ff 83%, 
                #ff0000 100%
              )`,
            }}
          >
            <div
              className="absolute top-0 bottom-0 w-3.5 -ml-1.75 rounded-full border-2 border-white shadow-md pointer-events-none"
              style={{
                left: `${(hsv.h / 360) * 100}%`,
                backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
              }}
            />
          </div>
        </div>

        {/* Current Color Readout */}
        <div className="flex items-center justify-between pt-1 border-t border-slate-100">
          <div className="flex items-center gap-2">
            <div
              className="w-5 h-5 rounded-md border border-slate-200 shadow-2xs"
              style={{ backgroundColor: currentHex }}
            />
            <span className="font-mono font-bold text-xs text-slate-800">{currentHex}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs rounded-lg transition cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </>,
    document.body
  );
};

const DEVICE_ICONS = [
  "Phone",
  "Tablet",
  "Laptop",
  "Desktop",
  "Watch",
  "Car",
  "Custom"
];

interface DeviceIconSelectProps {
  value: string;
  onChange: (val: string) => void;
}

const DeviceIconSelect: React.FC<DeviceIconSelectProps> = ({ value, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (icon: string) => {
    onChange(icon);
    setIsOpen(false);
  };

  const cleanValue = value.replace(/[^\w\s]/g, "").trim() || "Phone";

  return (
    <div className="relative w-full text-slate-800" ref={dropdownRef}>
      {/* Trigger Button - Closed Dropdown State */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-white border border-slate-200/80 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-xs cursor-pointer text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-50/80 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0">
            <DeviceIcon deviceIcon={cleanValue} className="w-4.5 h-4.5 text-indigo-600" />
          </div>
          <span className="font-semibold text-slate-800">{cleanValue}</span>
        </div>
        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
      </button>

      {/* Dropdown Options List - Open State */}
      {isOpen && (
        <div className="absolute z-50 mt-1.5 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto py-1 animate-in fade-in slide-in-from-top-1 duration-150">
          {DEVICE_ICONS.map((icon) => {
            const isSelected = cleanValue === icon;
            return (
              <button
                key={icon}
                type="button"
                onClick={() => handleSelect(icon)}
                className={`w-full flex items-center gap-3 px-3.5 py-2 text-left text-sm font-semibold transition cursor-pointer hover:bg-indigo-50/50 ${
                  isSelected ? "bg-indigo-50 text-indigo-600" : "text-slate-700"
                }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                  isSelected ? "bg-indigo-100/50 border-indigo-200 text-indigo-600" : "bg-slate-50 border-slate-100/80 text-slate-500"
                }`}>
                  <DeviceIcon deviceIcon={icon} className="w-4.5 h-4.5" />
                </div>
                <span className={isSelected ? "text-indigo-600 font-bold" : "text-slate-700"}>
                  {icon}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const SettingsTab: React.FC<SettingsTabProps> = ({
  user,
  onLogout,
  onClose,
  onUserUpdate,
  circles = [],
  selectedCircle = null,
  onCreateCircle,
  onJoinCircle,
  onLeaveCircle,
  circlesLoading = false
}) => {
  const getToken = () => localStorage.getItem("access_token") || localStorage.getItem("token") || "";

  // Section Expand States (Default all collapsed)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    account: false,
    familyCircle: false,
    maps: false,
    locationHistory: false,
    notifications: false,
    devices: false
  });

  const toggleSection = (section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // ----------------------------------------------------
  // SECTION 1: ACCOUNT STATE
  // ----------------------------------------------------
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [username, setUsername] = useState(user?.username || "");
  const [avatarColor, setAvatarColor] = useState(getAvatarColor(user?.avatar_color));
  const [hexInput, setHexInput] = useState(getAvatarColor(user?.avatar_color).toUpperCase());
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerBtnRef = useRef<HTMLButtonElement>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountSuccess, setAccountSuccess] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  // Photo state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [deletingPhoto, setDeletingPhoto] = useState(false);

  // Cropper states
  const [cropperImageSrc, setCropperImageSrc] = useState<string | null>(null);
  const [cropperZoom, setCropperZoom] = useState(1);
  const [cropperPosition, setCropperPosition] = useState({ x: 0, y: 0 });
  const [cropperIsDragging, setCropperIsDragging] = useState(false);
  const [cropperDragStart, setCropperDragStart] = useState({ x: 0, y: 0 });
  const [cropperImageSize, setCropperImageSize] = useState({ width: 0, height: 0 });
  const gestureRef = useRef({
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    initialPosition: { x: 0, y: 0 },
    initialDistance: 0,
    initialZoom: 1,
    isPinch: false
  });

  const cropperContainerRef = useRef<HTMLDivElement>(null);
  const cropperImageRef = useRef<HTMLImageElement>(null);
  const cropperGuideRef = useRef<HTMLDivElement>(null);
  const [cropGuidePosition, setCropGuidePosition] = useState({ x: 44, y: 44 });

  useEffect(() => {
    if (cropperImageSrc && cropperImageSize.width > 0) {
      const timer = setTimeout(() => {
        const container = cropperContainerRef.current;
        const imgEl = cropperImageRef.current;
        if (container && imgEl) {
          const containerRect = container.getBoundingClientRect();
          const imgRect = imgEl.getBoundingClientRect();
          
          // Calculate the exact center of the rendered image relative to the container origin
          const imageCenterX = (imgRect.left + imgRect.width / 2) - containerRect.left;
          const imageCenterY = (imgRect.top + imgRect.height / 2) - containerRect.top;
          
          // Center the 192px crop guide exactly over the image's center
          const guideLeft = imageCenterX - 96;
          const guideTop = imageCenterY - 96;
          
          setCropGuidePosition({ x: guideLeft, y: guideTop });
        }
      }, 50);
      return () => clearTimeout(timer);
    } else {
      setCropGuidePosition({ x: 44, y: 44 });
    }
  }, [cropperImageSrc, cropperImageSize]);

  // Password Modal
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || "");
      setUsername(user.username || "");
      const initialColor = getAvatarColor(user.avatar_color);
      setAvatarColor(initialColor);
      setHexInput(initialColor.toUpperCase());
    }
  }, [user]);

  const handleSelectPreset = (presetHex: string) => {
    setAvatarColor(presetHex);
    setHexInput(presetHex.toUpperCase());
  };

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHexInput(val);
    if (isValidHexColor(val)) {
      const normalized = normalizeHexColor(val);
      setAvatarColor(normalized);
    }
  };

  const handleHexInputBlur = () => {
    if (isValidHexColor(hexInput)) {
      const normalized = normalizeHexColor(hexInput);
      setHexInput(normalized);
      setAvatarColor(normalized);
    } else {
      setHexInput(getAvatarColor(avatarColor).toUpperCase());
    }
  };

  const handleNativeColorPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setHexInput(val);
    setAvatarColor(val);
  };

  const handleSaveAccount = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSavingAccount(true);
    setAccountError(null);
    setAccountSuccess(null);

    try {
      const token = getToken();
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          display_name: displayName.trim(),
          username: username.trim(),
          avatar_color: avatarColor
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to update profile");
      }

      const updated = await res.json();
      onUserUpdate?.(updated);
      setAccountSuccess("Account updated successfully!");
      setTimeout(() => setAccountSuccess(null), 3000);
    } catch (err: any) {
      setAccountError(err.message || "Failed to update profile");
    } finally {
      setSavingAccount(false);
    }
  };

  const resetCropper = () => {
    setCropperImageSrc(null);
    setCropperZoom(1);
    setCropperPosition({ x: 0, y: 0 });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setAccountError("Please select a valid image file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      setCropperImageSrc(src);
      setCropperZoom(1);
      setCropperPosition({ x: 0, y: 0 });

      // Calculate initial cover scale image size
      const img = new Image();
      img.onload = () => {
        const containerSize = 280;
        const ratio = img.naturalWidth / img.naturalHeight;
        let w = containerSize;
        let h = containerSize;
        if (ratio > 1) {
          w = containerSize * ratio;
        } else {
          h = containerSize / ratio;
        }
        setCropperImageSize({ width: w, height: h });
      };
      // CRITICAL: Registered onload before assigning src to prevent race conditions
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCroppedImage = async () => {
    if (!cropperImageSrc) return;
    setUploadingPhoto(true);
    setAccountError(null);

    try {
      // 1. Create a new Image object and register onload first
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = cropperImageSrc; // Set src AFTER onload is registered to guarantee execution!
      });

      // 2. Create canvas
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Failed to get 2D context");
      }

      // Exact pixel-for-pixel coordinate mapping from screen coordinates to the natural image
      const imgEl = cropperImageRef.current;
      const guideEl = cropperGuideRef.current;

      let sx = 0;
      let sy = 0;
      let sWidth = img.naturalWidth;
      let sHeight = img.naturalHeight;

      if (imgEl && guideEl) {
        const imgRect = imgEl.getBoundingClientRect();
        const guideRect = guideEl.getBoundingClientRect();

        // Calculate position of the crop guide relative to the rendered image on screen
        const xInRenderedImage = guideRect.left - imgRect.left;
        const yInRenderedImage = guideRect.top - imgRect.top;

        // Scale factor to map screen coordinates to original image coordinates
        const scaleX = img.naturalWidth / imgRect.width;
        const scaleY = img.naturalHeight / imgRect.height;

        // Crop box coordinates on the original image
        sx = xInRenderedImage * scaleX;
        sy = yInRenderedImage * scaleY;
        sWidth = guideRect.width * scaleX;
        sHeight = guideRect.height * scaleY;
      } else {
        // Fallback calculations using state
        const containerCenter = 140; // 280 / 2
        const cropRadius = 96; // 192 / 2

        const baseW = cropperImageSize.width;
        const baseH = cropperImageSize.height;
        const renderedW = baseW * cropperZoom;
        const renderedH = baseH * cropperZoom;

        const imageCenterX = containerCenter + cropperPosition.x;
        const imageCenterY = containerCenter + cropperPosition.y;

        const imageLeft = imageCenterX - renderedW / 2;
        const imageTop = imageCenterY - renderedH / 2;

        const cropLeft = cropGuidePosition.x;
        const cropTop = cropGuidePosition.y;

        const xInImagePixels = cropLeft - imageLeft;
        const yInImagePixels = cropTop - imageTop;

        const scaleToNaturalX = img.naturalWidth / renderedW;
        const scaleToNaturalY = img.naturalHeight / renderedH;

        sx = xInImagePixels * scaleToNaturalX;
        sy = yInImagePixels * scaleToNaturalY;
        sWidth = 192 * scaleToNaturalX;
        sHeight = 192 * scaleToNaturalY;
      }

      // Draw the exact sub-rectangle from the natural image onto the 512x512 canvas
      ctx.clearRect(0, 0, 512, 512);
      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, 512, 512);

      // 3. Compress/encode to JPEG with a good compression quality (0.85)
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(
          (b) => resolve(b),
          "image/jpeg",
          0.85
        );
      });

      if (!blob) {
        throw new Error("Failed to export canvas to Blob");
      }

      // Create a File object from the blob
      const processedFile = new File([blob], "profile_photo.jpg", { type: "image/jpeg" });

      // 4. Send the processed file to the upload endpoint
      const formData = new FormData();
      formData.append("file", processedFile);
      const token = getToken();

      const res = await fetch("/api/auth/profile/picture", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to upload photo");
      }

      const updated = await res.json();
      onUserUpdate?.(updated);
      setAccountSuccess("Profile photo updated!");
      setTimeout(() => setAccountSuccess(null), 3000);
      resetCropper();
      setShowPhotoModal(false);
    } catch (err: any) {
      setAccountError(err.message || "Failed to crop or upload photo");
    } finally {
      setUploadingPhoto(false);
    }
  };

  // DESKTOP: Mouse drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    setCropperIsDragging(true);
    setCropperDragStart({
      x: e.clientX - cropperPosition.x,
      y: e.clientY - cropperPosition.y
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!cropperIsDragging) return;
    setCropperPosition({
      x: e.clientX - cropperDragStart.x,
      y: e.clientY - cropperDragStart.y
    });
  };

  const handleMouseUp = () => {
    setCropperIsDragging(false);
  };

  // TOUCH DEVICES: Smooth pinch-to-zoom and pan handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.cancelable) {
      e.preventDefault();
    }

    if (e.touches.length === 1) {
      gestureRef.current.isDragging = true;
      gestureRef.current.isPinch = false;
      const t = e.touches[0];
      gestureRef.current.dragStart = {
        x: t.clientX - cropperPosition.x,
        y: t.clientY - cropperPosition.y
      };
    } else if (e.touches.length === 2) {
      gestureRef.current.isDragging = false;
      gestureRef.current.isPinch = true;

      const t1 = e.touches[0];
      const t2 = e.touches[1];

      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      gestureRef.current.initialDistance = dist;
      gestureRef.current.initialZoom = cropperZoom;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.cancelable) {
      e.preventDefault();
    }

    if (e.touches.length === 1 && gestureRef.current.isDragging) {
      const t = e.touches[0];
      setCropperPosition({
        x: t.clientX - gestureRef.current.dragStart.x,
        y: t.clientY - gestureRef.current.dragStart.y
      });
    } else if (e.touches.length === 2 && gestureRef.current.isPinch) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];

      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (gestureRef.current.initialDistance > 0) {
        const factor = dist / gestureRef.current.initialDistance;
        const newZoom = Math.min(4, Math.max(1, gestureRef.current.initialZoom * factor));
        setCropperZoom(newZoom);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      gestureRef.current.isDragging = false;
      gestureRef.current.isPinch = false;
    } else if (e.touches.length === 1) {
      gestureRef.current.isPinch = false;
      gestureRef.current.isDragging = true;
      const t = e.touches[0];
      gestureRef.current.dragStart = {
        x: t.clientX - cropperPosition.x,
        y: t.clientY - cropperPosition.y
      };
    }
  };

  // MOUSE WHEEL: Smooth mouse wheel / trackpad zooming
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = 0.05;
    const direction = e.deltaY < 0 ? 1 : -1;
    const newZoom = Math.min(4, Math.max(1, cropperZoom + direction * zoomFactor));
    setCropperZoom(newZoom);
  };

  const handleDeletePhoto = async () => {
    setDeletingPhoto(true);
    setAccountError(null);

    try {
      const token = getToken();
      const res = await fetch("/api/auth/profile/picture", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to remove photo");
      }

      const updated = await res.json();
      onUserUpdate?.(updated);
      setAccountSuccess("Profile photo removed!");
      setTimeout(() => setAccountSuccess(null), 3000);
    } catch (err: any) {
      setAccountError(err.message || "Failed to remove photo");
    } finally {
      setDeletingPhoto(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword.length < 6) {
      setPasswordError("New password must be at least 6 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }

    setPasswordLoading(true);

    try {
      const token = getToken();
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Failed to update password");
      }

      setPasswordSuccess("Password changed successfully!");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => {
        setShowPasswordModal(false);
        setPasswordSuccess(null);
      }, 1500);
    } catch (err: any) {
      setPasswordError(err.message || "Failed to change password");
    } finally {
      setPasswordLoading(false);
    }
  };

  // ----------------------------------------------------
  // SECTION 2: FAMILY CIRCLE STATE
  // ----------------------------------------------------
  const [circleQrUrl, setCircleQrUrl] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showSwitchWarning, setShowSwitchWarning] = useState<"join" | "create" | null>(null);
  const [showQRScanner, setShowQRScanner] = useState(false);

  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [newCircleNameInput, setNewCircleNameInput] = useState("");
  const [circleActionLoading, setCircleActionLoading] = useState(false);
  const [circleActionError, setCircleActionError] = useState<string | null>(null);

  // Generate QR Code when selectedCircle changes
  useEffect(() => {
    if (selectedCircle?.invite_code) {
      QRCode.toDataURL(selectedCircle.invite_code, {
        width: 220,
        margin: 2,
        color: {
          dark: "#1e293b",
          light: "#ffffff"
        }
      })
        .then((url) => setCircleQrUrl(url))
        .catch((err) => console.error("QR Generation error:", err));
    } else {
      setCircleQrUrl(null);
    }
  }, [selectedCircle?.invite_code]);

  const handleCopyInviteCode = () => {
    if (!selectedCircle?.invite_code) return;
    navigator.clipboard.writeText(selectedCircle.invite_code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleConfirmLeave = async () => {
    if (!selectedCircle || !onLeaveCircle) return;
    setCircleActionLoading(true);
    try {
      await onLeaveCircle(selectedCircle.id);
      setShowLeaveConfirm(false);
    } catch (err: any) {
      setCircleActionError(err.message || "Failed to leave circle");
    } finally {
      setCircleActionLoading(false);
    }
  };

  const executeJoinCircle = async (code: string) => {
    if (!onJoinCircle) return;
    setCircleActionLoading(true);
    setCircleActionError(null);
    try {
      await onJoinCircle(code.trim());
      setShowJoinModal(false);
      setShowQRScanner(false);
      setInviteCodeInput("");
    } catch (err: any) {
      setCircleActionError(err.message || "Invalid invite code or failed to join");
    } finally {
      setCircleActionLoading(false);
    }
  };

  const executeCreateCircle = async () => {
    if (!onCreateCircle || !newCircleNameInput.trim()) return;
    setCircleActionLoading(true);
    setCircleActionError(null);
    try {
      await onCreateCircle(newCircleNameInput.trim());
      setShowCreateModal(false);
      setNewCircleNameInput("");
    } catch (err: any) {
      setCircleActionError(err.message || "Failed to create circle");
    } finally {
      setCircleActionLoading(false);
    }
  };

  // ----------------------------------------------------
  // SECTION 3: MAPS STATE
  // ----------------------------------------------------
  const [mapStyle, setMapStyle] = useState<string>(user?.map_style || "osm");
  const [selectedIconSize, setSelectedIconSize] = useState<number>(
    user?.map_selected_icon_size || 72
  );
  const [unselectedIconSize, setUnselectedIconSize] = useState<number>(
    user?.map_unselected_icon_size || 64
  );

  useEffect(() => {
    if (user?.map_style) setMapStyle(user.map_style);
    if (user?.map_selected_icon_size) setSelectedIconSize(user.map_selected_icon_size);
    if (user?.map_unselected_icon_size) setUnselectedIconSize(user.map_unselected_icon_size);
  }, [user]);

  // Persist Maps settings
  const persistMapPreferences = async (updates: {
    map_style?: string;
    map_selected_icon_size?: number;
    map_unselected_icon_size?: number;
  }) => {
    try {
      const token = getToken();
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const updated = await res.json();
        onUserUpdate?.(updated);
      }
    } catch (err) {
      console.error("Failed to persist map preference:", err);
    }
  };

  const handleMapStyleChange = (newStyle: string) => {
    setMapStyle(newStyle);
    persistMapPreferences({ map_style: newStyle });
  };

  const handleSelectedIconSizeChange = (size: number) => {
    setSelectedIconSize(size);
    persistMapPreferences({ map_selected_icon_size: size });
  };

  const handleUnselectedIconSizeChange = (size: number) => {
    setUnselectedIconSize(size);
    persistMapPreferences({ map_unselected_icon_size: size });
  };

  // ----------------------------------------------------
  // SECTION 4: LOCATION & HISTORY STATE
  // ----------------------------------------------------
  const [shareLocation, setShareLocation] = useState<boolean>(
    user?.share_location !== false
  );
  const [saveLocationHistory, setSaveLocationHistory] = useState<boolean>(
    user?.save_location_history !== false
  );
  const [historyRetention, setHistoryRetention] = useState<string>(
    user?.history_retention || "30d"
  );
  const [locationUpdateFreq, setLocationUpdateFreq] = useState<string>(
    user?.location_update_frequency || "realtime"
  );

  useEffect(() => {
    if (user) {
      setShareLocation(user.share_location !== false);
      setSaveLocationHistory(user.save_location_history !== false);
      setHistoryRetention(user.history_retention || "30d");
      setLocationUpdateFreq(user.location_update_frequency || "realtime");
    }
  }, [user]);

  const persistLocationSettings = async (updates: {
    share_location?: boolean;
    save_location_history?: boolean;
    history_retention?: string;
    location_update_frequency?: string;
  }) => {
    try {
      const token = getToken();
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const updated = await res.json();
        onUserUpdate?.(updated);
      }
    } catch (err) {
      console.error("Failed to persist location setting:", err);
    }
  };

  // ----------------------------------------------------
  // SECTION 5: NOTIFICATIONS STATE
  // ----------------------------------------------------
  const [notifyPush, setNotifyPush] = useState<boolean>(user?.notify_push !== false);
  const [notifyArrivalDeparture, setNotifyArrivalDeparture] = useState<boolean>(
    user?.notify_arrival_departure !== false
  );
  const [notifyStopSharing, setNotifyStopSharing] = useState<boolean>(
    user?.notify_stop_sharing !== false
  );
  const [notifyLowBattery, setNotifyLowBattery] = useState<boolean>(
    user?.notify_low_battery !== false
  );
  const [notifyDeviceOffline, setNotifyDeviceOffline] = useState<boolean>(
    user?.notify_device_offline !== false
  );

  useEffect(() => {
    if (user) {
      setNotifyPush(user.notify_push !== false);
      setNotifyArrivalDeparture(user.notify_arrival_departure !== false);
      setNotifyStopSharing(user.notify_stop_sharing !== false);
      setNotifyLowBattery(user.notify_low_battery !== false);
      setNotifyDeviceOffline(user.notify_device_offline !== false);
    }
  }, [user]);

  const persistNotificationSetting = async (updates: {
    notify_push?: boolean;
    notify_arrival_departure?: boolean;
    notify_stop_sharing?: boolean;
    notify_low_battery?: boolean;
    notify_device_offline?: boolean;
  }) => {
    try {
      const token = getToken();
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const updated = await res.json();
        onUserUpdate?.(updated);
      }
    } catch (err) {
      console.error("Failed to persist notification setting:", err);
    }
  };

  // ----------------------------------------------------
  // SECTION 6: DEVICES STATE
  // ----------------------------------------------------
  const [devicesList, setDevicesList] = useState<UserDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editDeviceName, setEditDeviceName] = useState("");
  const [deleteConfirmDevice, setDeleteConfirmDevice] = useState<UserDevice | null>(null);
  const [deletingDeviceId, setDeletingDeviceId] = useState<string | null>(null);
  const [deviceActionError, setDeviceActionError] = useState<string | null>(null);
  const [deviceActionSuccess, setDeviceActionSuccess] = useState<string | null>(null);

  const fetchDevices = async () => {
    setDevicesLoading(true);
    try {
      const token = getToken();
      const res = await fetch("/api/devices", {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setDevicesList(data);
      }
    } catch (err) {
      console.error("Failed to fetch user devices:", err);
    } finally {
      setDevicesLoading(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  const handleUpdateDevice = async (
    entityId: string,
    updates: { name?: string; location_visibility?: "family" | "me_only"; map_icon?: string; allow_find_my_device?: boolean; is_default?: boolean }
  ) => {
    try {
      const token = getToken();
      const res = await fetch(`/api/devices/${encodeURIComponent(entityId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(updates)
      });

      if (res.ok) {
        if (updates.is_default) {
          await fetchDevices();
        } else {
          const updatedDevice = await res.json();
          setDevicesList((prev) =>
            prev.map((d) => (d.entity_id === entityId ? updatedDevice : d))
          );
        }
        setEditingDeviceId(null);
      }
    } catch (err) {
      console.error("Failed to update device:", err);
    }
  };

  const handleDeleteDevice = async (device: UserDevice) => {
    setDeletingDeviceId(device.entity_id);
    setDeviceActionError(null);
    try {
      const token = getToken();
      const res = await fetch(`/api/devices/${encodeURIComponent(device.entity_id)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to delete device");
      }

      setDevicesList((prev) => prev.filter((d) => d.entity_id !== device.entity_id));
      setDeleteConfirmDevice(null);
      setDeviceActionSuccess(`Device "${device.name}" was successfully removed.`);
      setTimeout(() => setDeviceActionSuccess(null), 4000);
    } catch (err: any) {
      console.error("Failed to delete device:", err);
      setDeviceActionError(err.message || "Failed to delete device. Please try again.");
    } finally {
      setDeletingDeviceId(null);
    }
  };

  return (
    <div className="w-full text-slate-800 pb-12 font-sans selection:bg-indigo-100">
      {/* Top Header Bar matching requested title styling */}
      <div className="flex items-center justify-between pb-6 mb-8 border-b border-slate-200/60 -mx-6 md:-mx-8 px-6 md:px-8">
        {/* Flush left edge, rounded right edge title */}
        <div
          id="settings-title"
          className="h-10 px-5 pl-4.5 bg-white/85 backdrop-blur-2xl border-y border-r border-white/80 shadow-[0_4px_20px_rgba(0,0,0,0.08)] flex items-center rounded-r-full select-none text-left focus:outline-none text-slate-800 -ml-6 md:-ml-8"
        >
          <span className="text-sm font-black tracking-wide">SETTINGS</span>
        </div>

        {/* Top-Right Action Controls */}
        <div className="flex items-center gap-2.5">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              id="back-to-map-button"
              className="h-10 px-3.5 rounded-full bg-white/80 hover:bg-slate-100 text-slate-600 hover:text-slate-900 border border-slate-200/80 shadow-xs text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
              title="Return to live map"
            >
              <X className="w-4 h-4" />
              <span className="hidden sm:inline">Back to Map</span>
            </button>
          )}

          <button
            type="button"
            onClick={onLogout}
            id="logout-button"
            className="h-10 px-4 rounded-full bg-white/80 hover:bg-rose-50 text-slate-700 hover:text-rose-600 border border-slate-200/80 shadow-xs text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
            title="Log out of current account"
          >
            <LogOut className="w-3.5 h-3.5 text-rose-500" />
            <span>Logout</span>
          </button>
        </div>
      </div>

      {/* ======================================================== */}
      {/* 1. ACCOUNT SECTION */}
      {/* ======================================================== */}
      <div
        id="section-account"
        className="bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_4px_24px_rgba(0,0,0,0.03)] rounded-3xl p-5 md:p-6 mb-6 transition-all"
      >
        <button
          type="button"
          onClick={() => toggleSection("account")}
          className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer select-none"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
              <User className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-base font-black tracking-tight text-slate-800">1. Account</h2>
              <p className="text-xs text-slate-400 font-medium">Profile details, avatar color, and credentials</p>
            </div>
          </div>
          <div className="p-1 text-slate-400 hover:text-slate-600 transition">
            {openSections.account ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </button>

        {openSections.account && (
          <div className="mt-6 pt-5 border-t border-slate-100/90 space-y-6">
            {/* Feedback notifications */}
            {accountSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-2xl text-xs font-semibold flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{accountSuccess}</span>
              </div>
            )}
            {accountError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{accountError}</span>
              </div>
            )}

            {/* Profile Photo Row */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div className="flex items-center gap-4">
                <div
                  className="w-16 h-16 flex items-center justify-center text-white font-black text-xl overflow-hidden shrink-0"
                  style={{ 
                    backgroundColor: getAvatarColor(avatarColor),
                    clipPath: "url(#squircle-clip-app)",
                    filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.15))"
                  }}
                >
                  {user?.profile_picture_url ? (
                    <img
                      src={user.profile_picture_url}
                      alt={displayName}
                      className="w-full h-full object-cover"
                      style={{ clipPath: "url(#squircle-clip-app)" }}
                    />
                  ) : (
                    <span>{(displayName || username || "U").charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">Profile Photo</h3>
                  <p className="text-xs text-slate-400 font-medium mt-0.5">
                    Visible to your circle members on the map
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => {
                    handleFileSelect(e);
                    setShowPhotoModal(true);
                  }}
                  accept="image/*"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => setShowPhotoModal(true)}
                  disabled={uploadingPhoto}
                  id="change-photo-btn"
                  className="px-4 py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold border border-slate-200/80 shadow-xs transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {uploadingPhoto ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  <span>{user?.profile_picture_url ? "Change Photo" : "Upload Photo"}</span>
                </button>

                {user?.profile_picture_url && (
                  <button
                    type="button"
                    onClick={handleDeletePhoto}
                    disabled={deletingPhoto}
                    id="remove-photo-btn"
                    className="p-2 rounded-xl bg-white hover:bg-rose-50 text-rose-600 border border-slate-200/80 shadow-xs transition cursor-pointer disabled:opacity-50"
                    title="Remove custom photo"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Form Fields: Display Name & Username */}
            <form onSubmit={handleSaveAccount} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Display Name
                  </label>
                  <input
                    type="text"
                    id="account-display-name-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Sarah Connor"
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200/80 rounded-xl text-sm font-medium text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs transition"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Username
                  </label>
                  <input
                    type="text"
                    id="account-username-input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. sarah"
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200/80 rounded-xl text-sm font-medium text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs transition"
                    required
                  />
                </div>
              </div>

              {/* Account Colours */}
              <div className="space-y-3" id="account-colours-container">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Colour
                </label>

                {/* Row 1: Exactly 7 selectable circular colour swatches in one compact row */}
                <div className="flex items-center gap-2.5 py-0.5">
                  {ACCOUNT_COLOUR_PRESETS.map((preset) => {
                    const isSelected = avatarColor.toLowerCase() === preset.hex.toLowerCase();
                    return (
                      <button
                        key={preset.hex}
                        type="button"
                        onClick={() => handleSelectPreset(preset.hex)}
                        id={`account-colour-preset-${preset.name.toLowerCase().replace(/\s+/g, "-")}`}
                        className={`w-7 h-7 rounded-full transition-all duration-150 flex items-center justify-center cursor-pointer shadow-2xs border shrink-0 ${
                          isSelected
                            ? "ring-2 ring-indigo-600 ring-offset-1.5 scale-105 border-indigo-400 shadow-xs"
                            : "hover:scale-105 border-black/10"
                        }`}
                        style={{ backgroundColor: preset.hex }}
                        title={`${preset.name} (${preset.hex})`}
                        aria-label={`${preset.name} ${preset.hex}`}
                        aria-pressed={isSelected}
                      >
                        {isSelected && <Check className="w-3 h-3 text-slate-800 stroke-[2.5]" />}
                      </button>
                    );
                  })}
                </div>

                {/* Row 2: HEX [ #________ ] [ colour swatch/picker ] */}
                <div className="flex items-center gap-2.5 pt-0.5">
                  <span className="text-xs font-bold text-slate-600 select-none tracking-wide">HEX</span>
                  <div className="relative w-32 sm:w-36">
                    <input
                      type="text"
                      id="account-hex-input"
                      value={hexInput}
                      onChange={handleHexInputChange}
                      onBlur={handleHexInputBlur}
                      placeholder="#FF9AA2"
                      maxLength={7}
                      className="w-full h-8 px-2.5 bg-white border border-slate-200/80 rounded-xl text-xs font-mono font-bold text-slate-800 uppercase focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs transition tracking-wide"
                      aria-label="Account Colour HEX Code"
                    />
                  </div>

                  {/* Polished Colour Swatch Picker Button */}
                  <div className="relative">
                    <button
                      ref={colorPickerBtnRef}
                      type="button"
                      id="account-color-picker-button"
                      onClick={() => setShowColorPicker(!showColorPicker)}
                      className={`w-8 h-8 rounded-xl border flex items-center justify-center cursor-pointer shadow-xs transition-all duration-150 hover:scale-105 active:scale-95 relative overflow-hidden shrink-0 ${
                        !ACCOUNT_COLOUR_PRESETS.some((p) => p.hex.toLowerCase() === avatarColor.toLowerCase())
                          ? "ring-2 ring-indigo-600 ring-offset-1.5 border-indigo-400 shadow-xs"
                          : "border-slate-200/90 hover:border-slate-300"
                      }`}
                      style={{
                        backgroundColor: getAvatarColor(avatarColor)
                      }}
                      title="Choose custom colour"
                      aria-label="Choose custom colour"
                    >
                      <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-black/10 pointer-events-none" />
                    </button>

                    {showColorPicker && (
                      <CustomColorPickerPopover
                        anchorRef={colorPickerBtnRef}
                        color={getAvatarColor(avatarColor)}
                        onChange={(newHex) => {
                          setAvatarColor(newHex);
                          setHexInput(newHex);
                        }}
                        onClose={() => setShowColorPicker(false)}
                      />
                    )}
                  </div>

                  {!ACCOUNT_COLOUR_PRESETS.some((p) => p.hex.toLowerCase() === avatarColor.toLowerCase()) && (
                    <span className="text-[11px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                      Custom Active
                    </span>
                  )}
                </div>
              </div>

              {/* Password Action Row */}
              <div className="pt-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t border-slate-100">
                <div>
                  <span className="text-xs font-bold text-slate-700 block">Password</span>
                  <span className="text-[11px] text-slate-400">Keep your login credentials secure</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(true)}
                  id="open-password-modal-btn"
                  className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5 text-slate-500" />
                  <span>Change password →</span>
                </button>
              </div>

              {/* Save Changes Button */}
              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={savingAccount}
                  id="save-account-changes-btn"
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-98 text-white font-bold text-xs shadow-sm transition flex items-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {savingAccount ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>Save Changes</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 2. FAMILY CIRCLE SECTION */}
      {/* ======================================================== */}
      <div
        id="section-family-circle"
        className="bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_4px_24px_rgba(0,0,0,0.03)] rounded-3xl p-5 md:p-6 mb-6 transition-all"
      >
        <button
          type="button"
          onClick={() => toggleSection("familyCircle")}
          className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer select-none"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
              <Users className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-base font-black tracking-tight text-slate-800">2. Family Circle</h2>
              <p className="text-xs text-slate-400 font-medium">Shared private map circle, QR code, and invites</p>
            </div>
          </div>
          <div className="p-1 text-slate-400 hover:text-slate-600 transition">
            {openSections.familyCircle ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </button>

        {openSections.familyCircle && (
          <div className="mt-6 pt-5 border-t border-slate-100/90">
            {circleActionError && (
              <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{circleActionError}</span>
              </div>
            )}

            {!selectedCircle ? (
              /* Case 1: User has NO circle */
              <div className="text-center py-6 px-4 bg-slate-50/70 rounded-2xl border border-slate-100">
                <Users className="w-10 h-10 text-slate-400 mx-auto mb-2 opacity-60" />
                <h3 className="text-sm font-bold text-slate-800">No Family Circle Joined</h3>
                <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1 mb-5">
                  Join an existing family circle using an invite code or create your own circle to share real-time location.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(true)}
                    id="create-circle-btn"
                    className="px-4.5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-2 cursor-pointer"
                  >
                    <PlusCircle className="w-4 h-4" />
                    <span>Create Circle</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowJoinModal(true)}
                    id="join-circle-btn"
                    className="px-4.5 py-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs border border-slate-200/80 shadow-xs transition flex items-center gap-2 cursor-pointer"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>Join Circle</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Case 2: User is IN a circle */
              <div className="space-y-6">
                {/* Circle Name Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4 rounded-2xl bg-indigo-50/50 border border-indigo-100/50">
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-indigo-600 block">
                      Active Circle
                    </span>
                    <h3 className="text-lg font-black text-slate-800 mt-0.5">{selectedCircle.name}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowLeaveConfirm(true)}
                      id="leave-circle-btn"
                      className="px-3.5 py-2 rounded-xl bg-white hover:bg-rose-50 text-rose-600 border border-rose-200/70 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Leave Circle</span>
                    </button>
                  </div>
                </div>

                {/* QR Code & Invite Code Display */}
                <div className="flex flex-col md:flex-row items-center justify-center gap-8 p-6 rounded-2xl bg-slate-50/60 border border-slate-100">
                  {/* QR Code card */}
                  <div className="flex flex-col items-center">
                    <div className="p-3.5 bg-white rounded-2xl shadow-sm border border-slate-200/70 inline-block">
                      {circleQrUrl ? (
                        <img
                          src={circleQrUrl}
                          alt="Circle Invite QR Code"
                          className="w-44 h-44 object-contain rounded-lg"
                        />
                      ) : (
                        <div className="w-44 h-44 bg-slate-100 animate-pulse rounded-lg flex items-center justify-center text-xs text-slate-400">
                          Generating QR...
                        </div>
                      )}
                    </div>
                    <span className="text-[11px] text-slate-400 font-semibold mt-2.5">
                      Scan with Yimly to join instantly
                    </span>
                  </div>

                  {/* Invite Code card */}
                  <div className="flex flex-col items-center md:items-start text-center md:text-left space-y-3">
                    <div>
                      <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block">
                        Invite Code
                      </span>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-2xl font-mono font-black tracking-widest text-slate-800 bg-white px-4 py-1.5 rounded-xl border border-slate-200 shadow-xs select-all">
                          {selectedCircle.invite_code}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyInviteCode}
                          id="copy-invite-code-btn"
                          className="p-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 shadow-xs transition cursor-pointer"
                          title="Copy invite code"
                        >
                          {copiedCode ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                      Share this code or QR code with family members to invite them to{" "}
                      <span className="font-bold text-slate-700">{selectedCircle.name}</span>.
                    </p>

                    {/* Switch Circle options */}
                    <div className="pt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setShowSwitchWarning("join")}
                        id="switch-join-btn"
                        className="px-3.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold border border-slate-200 transition cursor-pointer"
                      >
                        Join Another Circle
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowSwitchWarning("create")}
                        id="switch-create-btn"
                        className="px-3.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold border border-slate-200 transition cursor-pointer"
                      >
                        Create Another Circle
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 3. MAPS SECTION */}
      {/* ======================================================== */}
      <div
        id="section-maps"
        className="bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_4px_24px_rgba(0,0,0,0.03)] rounded-3xl p-5 md:p-6 mb-6 transition-all"
      >
        <button
          type="button"
          onClick={() => toggleSection("maps")}
          className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer select-none"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
              <MapIcon className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-base font-black tracking-tight text-slate-800">3. Maps</h2>
              <p className="text-xs text-slate-400 font-medium">Live preview, vector tile styling, and member marker sizes</p>
            </div>
          </div>
          <div className="p-1 text-slate-400 hover:text-slate-600 transition">
            {openSections.maps ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </button>

        {openSections.maps && (
          <div className="mt-6 pt-5 border-t border-slate-100/90 space-y-6">
            {/* 1. Live Map Preview (Top Half) */}
            <div>
              <MapLivePreview
                styleId={mapStyle}
                selectedIconSize={selectedIconSize}
                unselectedIconSize={unselectedIconSize}
                userColor={getAvatarColor(avatarColor)}
                userPhoto={user?.profile_picture_url}
                userInitial={(displayName || username || "U").charAt(0).toUpperCase()}
                deviceIcon={devicesList[0]?.map_icon || "📱 Phone"}
              />
            </div>

            {/* Controls (Bottom Half) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
              {/* 2. Map Tile Style Dropdown */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Map Tile Style
                </label>
                <div className="relative">
                  <select
                    id="map-style-dropdown"
                    value={mapStyle}
                    onChange={(e) => handleMapStyleChange(e.target.value)}
                    className="w-full appearance-none px-3.5 py-2.5 bg-white border border-slate-200/80 rounded-xl text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs cursor-pointer pr-10 transition"
                  >
                    {MAP_STYLES.map((style) => (
                      <option key={style.id} value={style.id}>
                        {style.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
                <p className="text-[11px] text-slate-400 font-medium">
                  {MAP_STYLES.find((s) => s.id === mapStyle)?.description || "Select street map design"}
                </p>
              </div>

              {/* 3. Selected Member Icon Size Slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Selected Icon Size
                  </label>
                  <span className="text-xs font-black px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100 font-mono">
                    {selectedIconSize}px
                  </span>
                </div>
                <input
                  type="range"
                  id="selected-icon-size-slider"
                  min={24}
                  max={72}
                  step={1}
                  value={selectedIconSize}
                  onChange={(e) => handleSelectedIconSizeChange(Number(e.target.value))}
                  className="w-full accent-indigo-600 cursor-pointer h-2 bg-slate-200 rounded-lg"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>24px</span>
                  <span className="text-indigo-600 font-bold">72px Default</span>
                  <span>72px</span>
                </div>
              </div>

              {/* 4. Unselected Member Icon Size Slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Unselected Icon Size
                  </label>
                  <span className="text-xs font-black px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-mono">
                    {unselectedIconSize}px
                  </span>
                </div>
                <input
                  type="range"
                  id="unselected-icon-size-slider"
                  min={24}
                  max={72}
                  step={1}
                  value={unselectedIconSize}
                  onChange={(e) => handleUnselectedIconSizeChange(Number(e.target.value))}
                  className="w-full accent-indigo-600 cursor-pointer h-2 bg-slate-200 rounded-lg"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>24px</span>
                  <span className="text-indigo-600 font-bold">64px Default</span>
                  <span>72px</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 4. LOCATION & HISTORY SECTION */}
      {/* ======================================================== */}
      <div
        id="section-location-history"
        className="bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_4px_24px_rgba(0,0,0,0.03)] rounded-3xl p-5 md:p-6 mb-6 transition-all"
      >
        <button
          type="button"
          onClick={() => toggleSection("locationHistory")}
          className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer select-none"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
              <Clock className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-base font-black tracking-tight text-slate-800">4. Location & History</h2>
              <p className="text-xs text-slate-400 font-medium">Broadcast toggles, breadcrumb logging, and data retention</p>
            </div>
          </div>
          <div className="p-1 text-slate-400 hover:text-slate-600 transition">
            {openSections.locationHistory ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </button>

        {openSections.locationHistory && (
          <div className="mt-6 pt-5 border-t border-slate-100/90 space-y-5">
            {/* Control 1: Share My Location Toggle */}
            <div className="flex items-center justify-between p-4 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Share My Location</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Allow members in your Family Circle to see your live position
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-share-location"
                  checked={shareLocation}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setShareLocation(val);
                    persistLocationSettings({ share_location: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {/* Control 2: Save Location History Toggle */}
            <div className="flex items-center justify-between p-4 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Save Location History</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Record position breadcrumbs to view routes and activity timeline
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-save-history"
                  checked={saveLocationHistory}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setSaveLocationHistory(val);
                    persistLocationSettings({ save_location_history: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {/* Control 3: History Retention Dropdown */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">History Retention</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Automatically purge historical telemetry older than this duration
                </p>
              </div>
              <div className="relative min-w-[150px]">
                <select
                  id="dropdown-history-retention"
                  value={historyRetention}
                  onChange={(e) => {
                    const val = e.target.value;
                    setHistoryRetention(val);
                    persistLocationSettings({ history_retention: val });
                  }}
                  className="w-full appearance-none px-3 py-2 bg-white border border-slate-200/80 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 pr-8 shadow-xs cursor-pointer"
                >
                  <option value="7d">7 Days</option>
                  <option value="30d">30 Days</option>
                  <option value="90d">90 Days</option>
                  <option value="1y">1 Year</option>
                  <option value="forever">Forever</option>
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* Control 4: Location Updates Dropdown */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Location Updates Frequency</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Interval for companion device location telemetry sync
                </p>
              </div>
              <div className="relative min-w-[150px]">
                <select
                  id="dropdown-location-frequency"
                  value={locationUpdateFreq}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocationUpdateFreq(val);
                    persistLocationSettings({ location_update_frequency: val });
                  }}
                  className="w-full appearance-none px-3 py-2 bg-white border border-slate-200/80 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 pr-8 shadow-xs cursor-pointer"
                >
                  <option value="realtime">Real-time</option>
                  <option value="1m">1 minute</option>
                  <option value="5m">5 minutes</option>
                  <option value="15m">15 minutes</option>
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 5. NOTIFICATIONS SECTION */}
      {/* ======================================================== */}
      <div
        id="section-notifications"
        className="bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_4px_24px_rgba(0,0,0,0.03)] rounded-3xl p-5 md:p-6 mb-6 transition-all"
      >
        <button
          type="button"
          onClick={() => toggleSection("notifications")}
          className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer select-none"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
              <Bell className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-base font-black tracking-tight text-slate-800">5. Notifications</h2>
              <p className="text-xs text-slate-400 font-medium">Push alert preferences, member arrivals, and battery warnings</p>
            </div>
          </div>
          <div className="p-1 text-slate-400 hover:text-slate-600 transition">
            {openSections.notifications ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </button>

        {openSections.notifications && (
          <div className="mt-6 pt-5 border-t border-slate-100/90 space-y-4">
            {/* Toggle 1: Push Notifications */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Push Notifications</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Master toggle for system and companion app notifications
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-notify-push"
                  checked={notifyPush}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setNotifyPush(val);
                    persistNotificationSetting({ notify_push: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {/* Toggle 2: Member Arrives / Leaves */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Member Arrives / Leaves</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Alert when a circle member enters or leaves geofenced places
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-notify-arrival-departure"
                  checked={notifyArrivalDeparture}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setNotifyArrivalDeparture(val);
                    persistNotificationSetting({ notify_arrival_departure: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {/* Toggle 3: Member Stops Sharing */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Member Stops Sharing</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Notify when a family member pauses or turns off location broadcast
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-notify-stop-sharing"
                  checked={notifyStopSharing}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setNotifyStopSharing(val);
                    persistNotificationSetting({ notify_stop_sharing: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {/* Toggle 4: Low Battery Alerts */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Low Battery Alerts</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Alert when a family member device battery drops below 15%
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-notify-low-battery"
                  checked={notifyLowBattery}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setNotifyLowBattery(val);
                    persistNotificationSetting({ notify_low_battery: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {/* Toggle 5: Device Offline Alerts */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Device Offline Alerts</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  Notify when a tracker has not reported telemetry for over 2 hours
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="toggle-notify-device-offline"
                  checked={notifyDeviceOffline}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setNotifyDeviceOffline(val);
                    persistNotificationSetting({ notify_device_offline: val });
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 6. DEVICES SECTION */}
      {/* ======================================================== */}
      <div
        id="section-devices"
        className="bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_4px_24px_rgba(0,0,0,0.03)] rounded-3xl p-5 md:p-6 mb-6 transition-all"
      >
        <button
          type="button"
          onClick={() => toggleSection("devices")}
          className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer select-none"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
              <Smartphone className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-base font-black tracking-tight text-slate-800">6. Devices</h2>
              <p className="text-xs text-slate-400 font-medium">Connected device trackers, visibility rules, and map badges</p>
            </div>
          </div>
          <div className="p-1 text-slate-400 hover:text-slate-600 transition">
            {openSections.devices ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </button>

        {openSections.devices && (
          <div className="mt-6 pt-5 border-t border-slate-100/90 space-y-4">
            {deviceActionError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl text-xs font-semibold flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{deviceActionError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDeviceActionError(null)}
                  className="text-rose-500 hover:text-rose-700 p-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {deviceActionSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-2xl text-xs font-semibold flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{deviceActionSuccess}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDeviceActionSuccess(null)}
                  className="text-emerald-500 hover:text-emerald-700 p-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {devicesLoading ? (
              <div className="flex items-center justify-center py-8 text-slate-400 text-xs font-semibold">
                <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                Loading connected devices...
              </div>
            ) : devicesList.length === 0 ? (
              <div className="text-center py-6 text-slate-400 text-xs font-medium">
                No companion device trackers detected. Install or pair the Home Assistant Companion app to track position.
              </div>
            ) : (
              devicesList.map((device) => {
                const isEditing = editingDeviceId === device.entity_id;
                return (
                  <div
                    key={device.entity_id}
                    className="p-5 rounded-2xl bg-slate-50/80 border border-slate-200/70 shadow-xs space-y-4"
                  >
                    {/* Device Header & Name */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-200/50">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-50/80 border border-indigo-100 flex items-center justify-center text-indigo-600 shadow-2xs shrink-0">
                          <DeviceIcon deviceIcon={device.map_icon} deviceName={device.name} className="w-5.5 h-5.5 text-indigo-600" />
                        </div>
                        <div>
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={editDeviceName}
                                onChange={(e) => setEditDeviceName(e.target.value)}
                                className="px-2.5 py-1 bg-white border border-indigo-400 rounded-lg text-sm font-bold text-slate-800 focus:outline-none"
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  handleUpdateDevice(device.entity_id, { name: editDeviceName.trim() })
                                }
                                className="p-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingDeviceId(null)}
                                className="p-1.5 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-bold text-slate-800">{device.name}</h3>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDeviceId(device.entity_id);
                                  setEditDeviceName(device.name);
                                }}
                                className="p-1 text-slate-400 hover:text-indigo-600 rounded-md transition cursor-pointer"
                                title="Rename device"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                            <span>{device.platform}</span>
                            <span>•</span>
                            <span className="capitalize">{device.state}</span>
                            <span>•</span>
                            <span>Battery: {device.battery}%</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-start sm:items-end gap-1.5">
                        <div className="text-[10px] text-slate-400 font-mono">
                          ID: {device.entity_id}
                        </div>
                        {device.is_default ? (
                          <span className="px-2.5 py-1 bg-indigo-100 text-indigo-700 text-[10px] font-extrabold rounded-full flex items-center gap-1 shadow-2xs">
                            <Check className="w-3 h-3 text-indigo-600" /> Default Shared Device
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleUpdateDevice(device.entity_id, { is_default: true })}
                            className="px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-600 hover:text-slate-900 border border-slate-200 text-[10px] font-bold rounded-full transition cursor-pointer shadow-2xs"
                          >
                            Set as Default Device
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Location Visibility Radio Group */}
                    <div className="space-y-2">
                      <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                        Location Visibility
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <label
                          className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition ${
                            device.location_visibility !== "me_only"
                              ? "bg-indigo-50/50 border-indigo-200 text-indigo-950 font-bold"
                              : "bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`visibility-${device.entity_id}`}
                            value="family"
                            checked={device.location_visibility !== "me_only"}
                            onChange={() =>
                              handleUpdateDevice(device.entity_id, { location_visibility: "family" })
                            }
                            className="sr-only"
                          />
                          <div
                            className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                              device.location_visibility !== "me_only"
                                ? "border-indigo-600 bg-indigo-600"
                                : "border-slate-300 bg-white"
                            }`}
                          >
                            {device.location_visibility !== "me_only" && (
                              <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            )}
                          </div>
                          <div className="text-xs">
                            <span className="block font-bold">Family Circle + Me</span>
                            <span className="text-[10px] text-slate-400 font-normal">
                              Visible to everyone in your circle
                            </span>
                          </div>
                        </label>

                        <label
                          className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition ${
                            device.location_visibility === "me_only"
                              ? "bg-indigo-50/50 border-indigo-200 text-indigo-950 font-bold"
                              : "bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`visibility-${device.entity_id}`}
                            value="me_only"
                            checked={device.location_visibility === "me_only"}
                            onChange={() =>
                              handleUpdateDevice(device.entity_id, { location_visibility: "me_only" })
                            }
                            className="sr-only"
                          />
                          <div
                            className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                              device.location_visibility === "me_only"
                                ? "border-indigo-600 bg-indigo-600"
                                : "border-slate-300 bg-white"
                            }`}
                          >
                            {device.location_visibility === "me_only" && (
                              <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            )}
                          </div>
                          <div className="text-xs">
                            <span className="block font-bold">Me only</span>
                            <span className="text-[10px] text-slate-400 font-normal">
                              Hidden from all circle members
                            </span>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Map Icon Dropdown */}
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                        Map Icon
                      </label>
                      <DeviceIconSelect
                        value={device.map_icon || "📱 Phone"}
                        onChange={(val) =>
                          handleUpdateDevice(device.entity_id, { map_icon: val })
                        }
                      />
                    </div>

                    {/* Allow Find My Device Toggle */}
                    <div className="flex items-center justify-between p-3.5 rounded-xl bg-white border border-slate-200/80 mt-2">
                      <div>
                        <span className="block text-xs font-bold text-slate-800">Allow Find My Device</span>
                        <span className="text-[10px] text-slate-400 font-medium">
                          Allow Family Circle members to trigger a sound alert on this device
                        </span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-2">
                        <input
                          type="checkbox"
                          checked={device.allow_find_my_device !== false}
                          onChange={(e) =>
                            handleUpdateDevice(device.entity_id, {
                              allow_find_my_device: e.target.checked
                            })
                          }
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                      </label>
                    </div>

                    {/* Delete Device Action */}
                    <div className="pt-2 flex justify-end border-t border-slate-200/50">
                      <button
                        type="button"
                        onClick={() => {
                          setDeviceActionError(null);
                          setDeleteConfirmDevice(device);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-200/80 transition cursor-pointer shadow-2xs"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete device</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* MODALS & OVERLAYS */}
      {/* ======================================================== */}

      {/* Delete Device Confirmation Modal */}
      {deleteConfirmDevice && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deletingDeviceId) {
              setDeleteConfirmDevice(null);
              setDeviceActionError(null);
            }
          }}
        >
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="text-center">
              <h3 className="text-base font-bold text-slate-800">Delete Device?</h3>
              <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed">
                Are you sure you want to delete <strong className="text-slate-800 font-bold">{deleteConfirmDevice.name}</strong>? This device will be permanently removed from your Yimly account.
              </p>
            </div>

            {deviceActionError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{deviceActionError}</span>
              </div>
            )}

            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmDevice(null);
                  setDeviceActionError(null);
                }}
                disabled={Boolean(deletingDeviceId)}
                className="flex-1 py-2.5 rounded-2xl text-xs font-bold text-slate-600 hover:bg-slate-100 border border-slate-200 transition cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDeleteDevice(deleteConfirmDevice)}
                disabled={Boolean(deletingDeviceId)}
                className="flex-1 py-2.5 rounded-2xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white transition cursor-pointer flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                {deletingDeviceId && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{deletingDeviceId ? "Deleting..." : "Delete"}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Change Password Modal */}
      {showPasswordModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
            <button
              onClick={() => {
                setShowPasswordModal(false);
                setPasswordError(null);
                setPasswordSuccess(null);
              }}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3">
              <KeyRound className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-800">Change Password</h3>
            <p className="text-xs text-slate-400 mt-1 mb-4">
              Enter your current password and choose a new secure password
            </p>

            {passwordError && (
              <div className="mb-3 p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{passwordError}</span>
              </div>
            )}
            {passwordSuccess && (
              <div className="mb-3 p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs font-semibold flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{passwordSuccess}</span>
              </div>
            )}

            <form onSubmit={handleChangePassword} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Current Password
                </label>
                <div className="relative">
                  <input
                    type={showCurrentPass ? "text" : "password"}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 pr-9"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPass(!showCurrentPass)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showCurrentPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  New Password
                </label>
                <div className="relative">
                  <input
                    type={showNewPass ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 pr-9"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPass(!showNewPass)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showNewPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Confirm New Password
                </label>
                <input
                  type={showNewPass ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  required
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {passwordLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>Save Password</span>
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* Join Circle Modal */}
      {showJoinModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
            <button
              onClick={() => {
                setShowJoinModal(false);
                setCircleActionError(null);
              }}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3">
              <LogIn className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-800">Join a Family Circle</h3>
            <p className="text-xs text-slate-400 mt-1 mb-4">
              Enter an invite code or scan a QR code from another family member
            </p>

            {circleActionError && (
              <div className="mb-3 p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{circleActionError}</span>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Circle Invite Code
                </label>
                <input
                  type="text"
                  value={inviteCodeInput}
                  onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. ABC123"
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono font-bold tracking-wider text-slate-800 uppercase placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowQRScanner(true)}
                  className="w-full py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Camera className="w-4 h-4 text-indigo-600" />
                  <span>Scan QR Code</span>
                </button>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowJoinModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => executeJoinCircle(inviteCodeInput)}
                  disabled={circleActionLoading || !inviteCodeInput.trim()}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {circleActionLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>Join</span>
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Create Circle Modal */}
      {showCreateModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
            <button
              onClick={() => {
                setShowCreateModal(false);
                setCircleActionError(null);
              }}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3">
              <PlusCircle className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-800">Create a Family Circle</h3>
            <p className="text-xs text-slate-400 mt-1 mb-4">
              Choose a friendly name for your new family circle
            </p>

            {circleActionError && (
              <div className="mb-3 p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{circleActionError}</span>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Circle Name
                </label>
                <input
                  type="text"
                  value={newCircleNameInput}
                  onChange={(e) => setNewCircleNameInput(e.target.value)}
                  placeholder="e.g. The Yimly Family"
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={executeCreateCircle}
                  disabled={circleActionLoading || !newCircleNameInput.trim()}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {circleActionLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>Create</span>
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Switch Circle Warning Modal */}
      {showSwitchWarning && selectedCircle && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-3">
              <AlertCircle className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-800">Switch Family Circle</h3>
            <p className="text-xs text-slate-600 mt-2 mb-4 leading-relaxed">
              You're currently in: <span className="font-bold text-slate-800">{selectedCircle.name}</span>.
              <br />
              {showSwitchWarning === "join"
                ? "Joining another circle will automatically remove you from your current circle."
                : "Creating another circle will automatically remove you from your current circle."}
            </p>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSwitchWarning(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = showSwitchWarning;
                  setShowSwitchWarning(null);
                  if (target === "join") {
                    setShowJoinModal(true);
                  } else {
                    setShowCreateModal(true);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-xs transition cursor-pointer"
              >
                Proceed
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Leave Circle Confirmation Modal */}
      {showLeaveConfirm && selectedCircle && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mb-3">
              <LogOut className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-800">Leave Family Circle</h3>
            <p className="text-xs text-slate-600 mt-2 mb-4 leading-relaxed">
              Are you sure you want to leave{" "}
              <span className="font-bold text-slate-800">{selectedCircle.name}</span>? You will stop sharing location with this circle.
            </p>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowLeaveConfirm(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmLeave}
                disabled={circleActionLoading}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {circleActionLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>Leave Circle</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* QR Scanner Modal */}
      <QRScannerModal
        isOpen={showQRScanner}
        onClose={() => setShowQRScanner(false)}
        onScan={(code) => {
          setInviteCodeInput(code.toUpperCase());
          setShowQRScanner(false);
          setShowJoinModal(true);
        }}
      />

      {/* Upload Photo Modal */}
      {showPhotoModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
            <button
              onClick={() => {
                resetCropper();
                setShowPhotoModal(false);
              }}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3">
              <Camera className="w-6 h-6" />
            </div>

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept="image/*"
              className="hidden"
            />

            {cropperImageSrc ? (
              <>
                <h3 className="text-base font-bold text-slate-800">Crop Profile Photo</h3>
                <p className="text-xs text-slate-400 mt-1 mb-4">
                  Drag to position, use the slider to zoom.
                </p>

                {/* Interactive Cropper Panel */}
                <div
                  className="relative w-full aspect-square max-w-[280px] mx-auto overflow-hidden bg-slate-950 rounded-2xl select-none touch-none cursor-move border border-slate-100"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onTouchCancel={handleTouchEnd}
                  onWheel={handleWheel}
                >
                  {/* Inner Container that accommodates the guide's position */}
                  <div
                    ref={cropperContainerRef}
                    className="w-full h-full relative"
                    style={{
                      transform: `translate(${44 - cropGuidePosition.x}px, ${44 - cropGuidePosition.y}px)`,
                    }}
                  >
                    <img
                      ref={cropperImageRef}
                      src={cropperImageSrc}
                      alt="Crop preview"
                      className="max-w-none max-h-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none select-none"
                      style={{
                        width: cropperImageSize.width,
                        height: cropperImageSize.height,
                        transform: `translate(calc(-50% + ${cropperPosition.x}px), calc(-50% + ${cropperPosition.y}px)) scale(${cropperZoom})`,
                      }}
                    />
                    {/* Overlay with 192px circular crop guide clear circle */}
                    <div className="absolute inset-0 pointer-events-none">
                      <div
                        ref={cropperGuideRef}
                        className="w-48 h-48 rounded-full border-2 border-white/90 shadow-[0_0_0_9999px_rgba(15,23,42,0.6)] absolute"
                        style={{
                          left: `${cropGuidePosition.x}px`,
                          top: `${cropGuidePosition.y}px`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Zoom Slider */}
                <div className="mt-4 mb-5 px-1">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-500 mb-1.5">
                    <span>Zoom</span>
                    <span>{Math.round(cropperZoom * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="4"
                    step="0.05"
                    value={cropperZoom}
                    onChange={(e) => setCropperZoom(parseFloat(e.target.value))}
                    className="w-full accent-indigo-600 h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={handleSaveCroppedImage}
                    disabled={uploadingPhoto}
                    className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md shadow-indigo-600/20 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                  >
                    {uploadingPhoto ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    <span>{uploadingPhoto ? "Saving & Uploading..." : "Save & Apply Photo"}</span>
                  </button>

                  <button
                    type="button"
                    onClick={resetCropper}
                    disabled={uploadingPhoto}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs transition cursor-pointer disabled:opacity-50"
                  >
                    Choose Different Image
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-base font-bold text-slate-800">Profile Photo</h3>
                <p className="text-xs text-slate-400 mt-1 mb-4">
                  Upload a custom profile photo visible to your circle members
                </p>

                {/* Profile Photo Preview */}
                <div className="flex flex-col items-center justify-center p-5 bg-slate-50/80 rounded-2xl border border-dashed border-slate-200 mb-5 text-center">
                  <div
                    className="w-20 h-20 flex items-center justify-center text-white font-black text-2xl overflow-hidden mb-3.5 relative shrink-0"
                    style={{ 
                      backgroundColor: getAvatarColor(avatarColor),
                      clipPath: "url(#squircle-clip-app)",
                      filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.15))"
                    }}
                  >
                    {user?.profile_picture_url ? (
                      <img
                        src={user.profile_picture_url}
                        alt={displayName}
                        className="w-full h-full object-cover"
                        style={{ clipPath: "url(#squircle-clip-app)" }}
                      />
                    ) : (
                      <span>{(displayName || username || "U").charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <p className="text-xs font-bold text-slate-700 mb-0.5">
                    {user?.profile_picture_url ? "Custom Photo Active" : "Default Avatar Active"}
                  </p>
                  <p className="text-[11px] text-slate-400 font-medium">
                    Supports JPG, PNG, GIF, WebP (max 5MB)
                  </p>
                </div>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingPhoto}
                    className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md shadow-indigo-600/20 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Choose Image to Crop</span>
                  </button>

                  {user?.profile_picture_url && (
                    <button
                      type="button"
                      onClick={async () => {
                        await handleDeletePhoto();
                        setShowPhotoModal(false);
                      }}
                      disabled={deletingPhoto}
                      className="w-full py-2.5 px-4 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold text-xs transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      {deletingPhoto ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      <span>Remove Custom Photo</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      resetCropper();
                      setShowPhotoModal(false);
                    }}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs transition cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
