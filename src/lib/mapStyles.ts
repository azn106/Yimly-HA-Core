import type { StyleSpecification } from "maplibre-gl";

export interface MapStyleOption {
  id: string;
  name: string;
  description: string;
  style: string | StyleSpecification;
  attribution: string;
  previewBg: string;
  accentColor: string;
}

const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }
  },
  layers: [
    {
      id: "osm-tiles-layer",
      type: "raster",
      source: "osm-tiles",
      minzoom: 0,
      maxzoom: 19
    }
  ]
};

export const MAP_STYLES: MapStyleOption[] = [
  {
    id: "osm",
    name: "OpenStreetMap Standard",
    description: "Classic community street map layout",
    style: OSM_RASTER_STYLE,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    previewBg: "bg-emerald-50 border-emerald-200 text-emerald-800",
    accentColor: "#10b981"
  },
  {
    id: "openfree_positron",
    name: "Positron",
    description: "Clean, light & minimal vector canvas",
    style: "https://tiles.openfreemap.org/styles/positron",
    attribution: '&copy; <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    previewBg: "bg-slate-50 border-slate-200 text-slate-800",
    accentColor: "#64748b"
  },
  {
    id: "openfree_bright",
    name: "Bright",
    description: "High-contrast colorful vector streets",
    style: "https://tiles.openfreemap.org/styles/bright",
    attribution: '&copy; <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    previewBg: "bg-amber-50 border-amber-200 text-amber-800",
    accentColor: "#f59e0b"
  },
  {
    id: "openfree_liberty",
    name: "Liberty",
    description: "Vibrant OSM Liberty vector design",
    style: "https://tiles.openfreemap.org/styles/liberty",
    attribution: '&copy; <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    previewBg: "bg-indigo-50 border-indigo-200 text-indigo-800",
    accentColor: "#6366f1"
  },
  {
    id: "openfree_dark",
    name: "Dark",
    description: "Sleek, high-contrast dark theme vector canvas",
    style: "https://tiles.openfreemap.org/styles/dark",
    attribution: '&copy; <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    previewBg: "bg-slate-900 border-slate-700 text-slate-100",
    accentColor: "#38bdf8"
  },
  {
    id: "openfree_fiord",
    name: "Fiord",
    description: "Cool blue-gray muted vector style",
    style: "https://tiles.openfreemap.org/styles/fiord",
    attribution: '&copy; <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    previewBg: "bg-cyan-900 border-cyan-700 text-cyan-100",
    accentColor: "#06b6d4"
  }
];

export function getMapStyle(styleId?: string | null): MapStyleOption {
  if (!styleId) return MAP_STYLES[0];
  // Map legacy IDs if present in DB
  if (styleId === "carto_positron") return MAP_STYLES.find(s => s.id === "openfree_positron")!;
  if (styleId === "carto_voyager") return MAP_STYLES.find(s => s.id === "openfree_bright")!;
  if (styleId === "carto_dark") return MAP_STYLES.find(s => s.id === "openfree_dark")!;

  return MAP_STYLES.find((s) => s.id === styleId) || MAP_STYLES[0];
}
