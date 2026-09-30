import React from "react";

interface YimlyBrandIconProps {
  className?: string;
  size?: number;
}

export const YimlyBrandIcon: React.FC<YimlyBrandIconProps> = ({
  className = "w-12 h-12",
  size
}) => {
  const style = size ? { width: size, height: size } : undefined;

  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <defs>
        {/* Soft Warm Pastel Background Gradient */}
        <linearGradient id="yimly-house-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFBEB" />
          <stop offset="100%" stopColor="#EEF2FF" />
        </linearGradient>

        {/* Warm Friendly Roof Gradient (Lavender to Peach/Coral) */}
        <linearGradient id="yimly-roof-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#F472B6" />
        </linearGradient>

        {/* House Body Gradient (Soft Sky Blue to Indigo) */}
        <linearGradient id="yimly-body-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#6366F1" />
        </linearGradient>

        {/* Door Glow Gradient (Sunny Yellow) */}
        <linearGradient id="yimly-door-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FEF08A" />
          <stop offset="100%" stopColor="#FBBF24" />
        </linearGradient>

        {/* Window Glow Gradient (Soft Mint) */}
        <linearGradient id="yimly-window-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A7F3D0" />
          <stop offset="100%" stopColor="#34D399" />
        </linearGradient>

        {/* Soft Drop Shadow */}
        <filter id="yimly-soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#4338CA" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* Outer Warm Pastel Squircle App Container */}
      <path
        d="M 50 6 C 80 6 94 20 94 50 C 94 80 80 94 50 94 C 20 94 6 80 6 50 C 6 20 20 6 50 6 Z"
        fill="url(#yimly-house-bg)"
        stroke="#E0E7FF"
        strokeWidth="1.5"
      />

      {/* House Base Body */}
      <rect x="25" y="44" width="50" height="38" rx="8" fill="url(#yimly-body-grad)" filter="url(#yimly-soft-shadow)" />

      {/* House Roof (Soft Rounded Roof) */}
      <path
        d="M 18 47 L 44.5 22.5 C 47.8 19.5 52.2 19.5 55.5 22.5 L 82 47 C 84 49 83 51 80 51 L 20 51 C 17 51 16 49 18 47 Z"
        fill="url(#yimly-roof-grad)"
      />

      {/* Soft Mint Windows */}
      <rect x="31" y="50" width="10" height="10" rx="3" fill="url(#yimly-window-grad)" />
      <rect x="59" y="50" width="10" height="10" rx="3" fill="url(#yimly-window-grad)" />

      {/* Arched Doorway with Warm Sunny Yellow Glow */}
      <path d="M 42 82 L 42 67 C 42 62.5 45.5 59 50 59 C 54.5 59 58 62.5 58 67 L 58 82 Z" fill="url(#yimly-door-grad)" />

      {/* Subtle Heart / Family Emblem in Doorway */}
      <path
        d="M 50 68.5 C 50 68.5 46.5 66 46.5 64.2 C 46.5 63 47.5 62 48.7 62 C 49.5 62 50 62.5 50 62.5 C 50 62.5 50.5 62 51.3 62 C 52.5 62 53.5 63 53.5 64.2 C 53.5 66 50 68.5 50 68.5 Z"
        fill="#9A3412"
        opacity="0.85"
      />
    </svg>
  );
};
