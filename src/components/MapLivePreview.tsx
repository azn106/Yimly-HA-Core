import React, { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getMapStyle } from "../lib/mapStyles";
import { renderMarkerHTML, getMarkerDimensions } from "../lib/markerRenderer";
import { DEFAULT_AVATAR_COLOR, getAvatarColor } from "../lib/avatarColor";

interface MapLivePreviewProps {
  styleId: string;
  pinType?: string | null;
  selectedIconSize: number;
  unselectedIconSize: number;
  userColor?: string;
  userPhoto?: string | null;
  userInitial?: string;
  deviceIcon?: string;
}

export const MapLivePreview: React.FC<MapLivePreviewProps> = ({
  styleId,
  pinType = "classic_pin",
  selectedIconSize,
  unselectedIconSize,
  userColor = DEFAULT_AVATAR_COLOR,
  userPhoto = null,
  userInitial = "U",
  deviceIcon = "📱 Phone"
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const selectedMarkerRef = useRef<maplibregl.Marker | null>(null);
  const unselectedMarkerRef = useRef<maplibregl.Marker | null>(null);

  // Initialize Map
  useEffect(() => {
    if (!containerRef.current) return;

    const styleOpt = getMapStyle(styleId);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleOpt.style,
      center: [-122.4194, 37.7749],
      zoom: 13,
      attributionControl: false,
      interactive: true
    });

    mapRef.current = map;

    // Create Selected Marker Element
    const selEl = document.createElement("div");
    selEl.className = "preview-selected-marker flex items-center justify-center transition-all duration-150";
    const selectedMarker = new maplibregl.Marker({ element: selEl, anchor: "bottom" })
      .setLngLat([-122.4194, 37.7749])
      .addTo(map);
    selectedMarkerRef.current = selectedMarker;

    // Create Unselected Marker Element
    const unselEl = document.createElement("div");
    unselEl.className = "preview-unselected-marker flex items-center justify-center transition-all duration-150";
    const unselectedMarker = new maplibregl.Marker({ element: unselEl, anchor: "bottom" })
      .setLngLat([-122.4080, 37.7830])
      .addTo(map);
    unselectedMarkerRef.current = unselectedMarker;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update Map Style when styleId changes
  useEffect(() => {
    if (!mapRef.current) return;
    const styleOpt = getMapStyle(styleId);
    mapRef.current.setStyle(styleOpt.style);
  }, [styleId]);

  // Update Markers HTML and sizes
  useEffect(() => {
    const rawEmoji = deviceIcon ? deviceIcon.split(" ")[0] : "📱";
    const activePinType = pinType || "classic_pin";

    // Update Selected Marker
    if (selectedMarkerRef.current) {
      const dims = getMarkerDimensions(activePinType, selectedIconSize);
      const el = selectedMarkerRef.current.getElement();
      el.style.width = `${dims.width}px`;
      el.style.height = `${dims.height}px`;

      el.innerHTML = renderMarkerHTML({
        pinType: activePinType,
        baseColor: getAvatarColor(userColor),
        isSelected: true,
        size: selectedIconSize,
        photoUrl: userPhoto,
        memberName: userInitial,
        deviceIcon: rawEmoji,
        batteryLevel: 95,
        showBattery: true
      });
    }

    // Update Unselected Marker
    if (unselectedMarkerRef.current) {
      const memberColor = "#A8E6CF";
      const dims = getMarkerDimensions(activePinType, unselectedIconSize);
      const el = unselectedMarkerRef.current.getElement();
      el.style.width = `${dims.width}px`;
      el.style.height = `${dims.height}px`;

      el.innerHTML = renderMarkerHTML({
        pinType: activePinType,
        baseColor: memberColor,
        isSelected: false,
        size: unselectedIconSize,
        photoUrl: null,
        memberName: "M",
        deviceIcon: "📱",
        batteryLevel: 82,
        showBattery: true
      });
    }
  }, [pinType, selectedIconSize, unselectedIconSize, userColor, userPhoto, userInitial, deviceIcon]);

  return (
    <div className="relative w-full h-64 md:h-72 rounded-2xl overflow-hidden border border-slate-200/80 shadow-inner bg-slate-100">
      <div ref={containerRef} className="w-full h-full" />
      <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md px-3 py-1 rounded-full text-[11px] font-bold text-slate-700 shadow-xs border border-white/60 pointer-events-none flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        Live Map Preview
      </div>
      <div className="absolute bottom-3 right-3 bg-white/90 backdrop-blur-md px-2.5 py-1 rounded-lg text-[10px] text-slate-500 font-medium shadow-xs border border-white/60 pointer-events-none">
        Selected: {selectedIconSize}px • Unselected: {unselectedIconSize}px
      </div>
    </div>
  );
};
