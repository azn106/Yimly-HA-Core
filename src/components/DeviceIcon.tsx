import React from "react";

interface DeviceIconProps {
  deviceIcon?: string;
  deviceName?: string;
  className?: string;
}

// 1. Single Source of Truth Raw SVG String Templates
export const PhoneSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <rect x="6.25" y="2" width="11.5" height="20" rx="3.2" class="fill-indigo-50/60" />
    <path d="M10.5 4.5h3" class="stroke-indigo-600/80" stroke-width="1.5" />
    <path d="M10 19.5h4" class="stroke-indigo-600/80" stroke-width="1.5" />
  </svg>
`;

export const IPadSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <rect x="3.5" y="2.75" width="17" height="18.5" rx="2.5" class="fill-indigo-50/60" />
    <circle cx="12" cy="5.2" r="0.75" fill="currentColor" class="text-indigo-600/90" stroke="none" />
    <path d="M10 18.75h4" class="stroke-indigo-600/80" stroke-width="1.5" />
  </svg>
`;

export const LaptopSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <rect x="3.5" y="4" width="17" height="11.5" rx="1.8" class="fill-indigo-50/60" />
    <path d="M2 18.5h20a1 1 0 0 0 1-1v-0.5H1v0.5a1 1 0 0 0 1 1z" fill="currentColor" fill-opacity="0.1" />
    <path d="M10.5 16.5h3" class="stroke-indigo-600/80" stroke-width="1.2" />
  </svg>
`;

export const DesktopSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <rect x="2" y="3" width="20" height="13.5" rx="2" class="fill-indigo-50/60" />
    <path d="M12 16.5v4" />
    <path d="M8 20.5h8" />
  </svg>
`;

export const WatchSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <rect x="6.5" y="6" width="11" height="12" rx="3.5" class="fill-indigo-50/60" />
    <path d="M9 2h6v4H9z" fill="currentColor" fill-opacity="0.1" />
    <path d="M9 18h6v4H9z" fill="currentColor" fill-opacity="0.1" />
  </svg>
`;

export const CarSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H7c-.7 0-1.3.3-1.7.8L3.2 10.5C2.5 10.8 2 11.5 2 12.3V16c0 .6.4 1 1 1h2" class="fill-indigo-50/60" />
    <circle cx="7" cy="17" r="2" fill="currentColor" fill-opacity="0.1" />
    <circle cx="17" cy="17" r="2" fill="currentColor" fill-opacity="0.1" />
  </svg>
`;

export const TrackerSVG = (className = "w-5 h-5") => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${className}">
    <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z" class="fill-indigo-50/60" />
    <circle cx="12" cy="10" r="2.8" fill="currentColor" fill-opacity="0.1" />
  </svg>
`;

// 2. Exact mapping function returning raw SVG string
export const getDeviceIconSVGString = (
  deviceIcon?: string,
  deviceName?: string,
  className = "w-5 h-5 text-indigo-600"
): string => {
  const str = ((deviceIcon || "") + " " + (deviceName || "")).toLowerCase();

  if (str.includes("ipad") || str.includes("tablet") || str.includes("📟") || str.includes("tab")) {
    return IPadSVG(className);
  }
  if (str.includes("phone") || str.includes("iphone") || str.includes("📱") || str.includes("mobile") || str.includes("smartphone")) {
    return PhoneSVG(className);
  }
  if (str.includes("laptop") || str.includes("macbook") || str.includes("💻")) {
    return LaptopSVG(className);
  }
  if (str.includes("desktop") || str.includes("imac") || str.includes("pc") || str.includes("🖥")) {
    return DesktopSVG(className);
  }
  if (str.includes("watch") || str.includes("⌚")) {
    return WatchSVG(className);
  }
  if (str.includes("car") || str.includes("vehicle") || str.includes("🚗")) {
    return CarSVG(className);
  }
  return TrackerSVG(className);
};

// 3. React components using the same SVG string templates for perfect synchronization
export const PhoneDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: PhoneSVG(className) }} />
);

export const IPadDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: IPadSVG(className) }} />
);

export const LaptopDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: LaptopSVG(className) }} />
);

export const DesktopDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: DesktopSVG(className) }} />
);

export const WatchDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: WatchSVG(className) }} />
);

export const CarDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: CarSVG(className) }} />
);

export const TrackerDeviceIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <div className="contents" dangerouslySetInnerHTML={{ __html: TrackerSVG(className) }} />
);

export const DeviceIcon: React.FC<DeviceIconProps> = ({
  deviceIcon,
  deviceName,
  className = "w-5 h-5 text-indigo-600"
}) => {
  const html = getDeviceIconSVGString(deviceIcon, deviceName, className);
  return <div className="contents" dangerouslySetInnerHTML={{ __html: html }} />;
};
