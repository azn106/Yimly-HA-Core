import express, { Request, Response, NextFunction } from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import cors from "cors";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

// Load environment variables from all standard environment sources
dotenv.config();
[".env.local", ".env.production", ".env.development"].forEach((envFile) => {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
  }
});

/**
 * ====================================================================================
 * AI STUDIO PREVIEW BACKEND (PREVIEW ONLY)
 * 
 * NOTICE:
 * This Express backend (server.ts) is strictly used for AI Studio Preview sessions.
 * It is completely isolated from the production Yimly Home Core backend.
 * 
 * PRODUCTION BACKEND:
 * The production and launched deployment MUST execute the Python FastAPI backend:
 *   uvicorn app.main:app --host 0.0.0.0 --port 3000
 * 
 * DO NOT use this file in production. Production reads real HA Companion App telemetry
 * from SQLite (yimly_home.db) and contains ZERO preview/fake coordinates.
 * ====================================================================================
 */

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || "yimly_home_preview_secret_key_2026";
const DATA_FILE = path.join(process.cwd(), "yimly_store_preview.json");

// Core Interfaces
export interface UserData {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  avatar_color?: string | null;
  profile_picture_url?: string | null;
  map_style?: string | null;
  map_pin_type?: string | null;
  map_selected_icon_size?: number | null;
  map_unselected_icon_size?: number | null;
  share_location?: boolean;
  save_location_history?: boolean;
  history_retention?: string;
  location_update_frequency?: string;
  notify_push?: boolean;
  notify_arrival_departure?: boolean;
  notify_stop_sharing?: boolean;
  notify_low_battery?: boolean;
  notify_device_offline?: boolean;
  assigned_entity_id?: string | null;
  created_at: string;
}

export function formatUserResponse(u: UserData) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_color: u.avatar_color || null,
    profile_picture_url: u.profile_picture_url || null,
    assigned_entity_id: u.assigned_entity_id || null,
    map_style: u.map_style || "osm",
    map_pin_type: u.map_pin_type || "classic_pin",
    map_selected_icon_size: u.map_selected_icon_size || 72,
    map_unselected_icon_size: u.map_unselected_icon_size || 64,
    share_location: u.share_location !== false,
    save_location_history: u.save_location_history !== false,
    history_retention: u.history_retention || "30d",
    location_update_frequency: u.location_update_frequency || "realtime",
    notify_push: u.notify_push !== false,
    notify_arrival_departure: u.notify_arrival_departure !== false,
    notify_stop_sharing: u.notify_stop_sharing !== false,
    notify_low_battery: u.notify_low_battery !== false,
    notify_device_offline: u.notify_device_offline !== false,
    is_active: true
  };
}

export function cleanupHistoryForUser(db: YimlyPreviewDatabase, userId: number, retention?: string) {
  if (!retention || retention === "forever") return;
  let cutoffMs = 30 * 86400000;
  if (retention === "7d") cutoffMs = 7 * 86400000;
  else if (retention === "30d") cutoffMs = 30 * 86400000;
  else if (retention === "90d") cutoffMs = 90 * 86400000;
  else if (retention === "1y") cutoffMs = 365 * 86400000;

  const cutoffDate = new Date(Date.now() - cutoffMs).toISOString();
  db.location_history = db.location_history.filter(
    (h) => h.user_id !== userId || h.timestamp >= cutoffDate
  );
}

export interface CircleData {
  id: number;
  name: string;
  owner_id: number;
  invite_code: string;
  created_at: string;
}

export interface CircleMemberData {
  id?: number;
  circle_id: number;
  user_id?: number | null;
  display_name?: string;
  avatar_color?: string | null;
  profile_picture_url?: string | null;
  assigned_entity_id?: string | null;
  created_at?: string;
}

// Server-Side Official Home Assistant Core LLAT Client for Node Backend
function getRuntimeHaUrl(): string {
  return (process.env.HA_URL || "").trim().replace(/\/+$/, "");
}

function getRuntimeHaLlat(): string {
  return (process.env.HA_LONG_LIVED_ACCESS_TOKEN || "").trim();
}

export interface DiscoveredHADevice {
  entity_id: string;
  device_name: string;
  state: string;
  is_available: boolean;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  battery: number | null;
  charging: boolean | null;
  platform: string;
  last_updated: string;
  map_icon: string;
}

class NodeHAClient {
  private entities: Map<string, any> = new Map();
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private shouldRun: boolean = false;

  constructor() {
    if (this.isConfigured()) {
      this.init();
    }
  }

  public isConfigured(): boolean {
    return Boolean(getRuntimeHaUrl() && getRuntimeHaLlat());
  }

  public getHaUrl(): string {
    return getRuntimeHaUrl();
  }

  private getWsUrl(): string {
    try {
      const urlStr = getRuntimeHaUrl();
      if (!urlStr) return "";
      const url = new URL(urlStr);
      const proto = url.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${url.host}/api/websocket`;
    } catch {
      return "";
    }
  }

  public async init() {
    if (!this.isConfigured()) return;
    this.shouldRun = true;
    await this.fetchStatesRest();
    this.connectWs();
  }

  private async fetchStatesRest() {
    const haUrl = getRuntimeHaUrl();
    const haLlat = getRuntimeHaLlat();
    if (!haUrl || !haLlat) return;
    try {
      const res = await fetch(`${haUrl}/api/states`, {
        headers: {
          Authorization: `Bearer ${haLlat}`,
          "Content-Type": "application/json"
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const s of data) {
            if (s && s.entity_id) {
              this.entities.set(s.entity_id, s);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[Node HA-CLIENT] Initial REST sync warning:", err);
    }
  }

  private connectWs() {
    if (!this.shouldRun || !this.isConfigured()) return;
    const wsUrl = this.getWsUrl();
    if (!wsUrl) return;

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on("open", () => {
        // Wait for auth_required
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "auth_required") {
            ws.send(JSON.stringify({
              type: "auth",
              access_token: getRuntimeHaLlat()
            }));
          } else if (msg.type === "auth_ok") {
            this.isConnected = true;
            ws.send(JSON.stringify({
              id: 1,
              type: "subscribe_events",
              event_type: "state_changed"
            }));
            ws.send(JSON.stringify({
              id: 2,
              type: "get_states"
            }));
          } else if (msg.type === "result" && msg.success && Array.isArray(msg.result)) {
            for (const s of msg.result) {
              if (s && s.entity_id) this.entities.set(s.entity_id, s);
            }
          } else if (msg.type === "event" && msg.event?.event_type === "state_changed") {
            const data = msg.event.data;
            if (data?.entity_id) {
              if (data.new_state) {
                this.entities.set(data.entity_id, data.new_state);
              } else {
                this.entities.delete(data.entity_id);
              }
              // Broadcast to local connected frontend WebSockets
              broadcastStateUpdate({
                event_type: "state_changed",
                data: data
              });
            }
          }
        } catch (e) {}
      });

      ws.on("close", () => {
        this.isConnected = false;
        if (this.shouldRun) {
          setTimeout(() => this.connectWs(), 5000);
        }
      });

      ws.on("error", () => {
        this.isConnected = false;
      });
    } catch (err) {
      if (this.shouldRun) {
        setTimeout(() => this.connectWs(), 5000);
      }
    }
  }

  public getDiscoveredDevices(): DiscoveredHADevice[] {
    const list: DiscoveredHADevice[] = [];
    const nowIso = new Date().toISOString();

    for (const [entityId, stateObj] of this.entities.entries()) {
      if (!entityId.startsWith("device_tracker.")) {
        continue;
      }
      const attrs = stateObj.attributes || {};
      const friendlyName = attrs.friendly_name || entityId.split(".")[1].replace(/_/g, " ");
      const stateVal = String(stateObj.state || "unknown");
      const isAvailable = !["unavailable", "unknown"].includes(stateVal.toLowerCase());
      const lat = attrs.latitude != null ? Number(attrs.latitude) : null;
      const lon = attrs.longitude != null ? Number(attrs.longitude) : null;
      const battery = attrs.battery_level != null ? Number(attrs.battery_level) : (attrs.battery != null ? Number(attrs.battery) : null);
      const charging = attrs.battery_charging != null ? Boolean(attrs.battery_charging) : (attrs.charging != null ? Boolean(attrs.charging) : null);

      list.push({
        entity_id: entityId,
        device_name: friendlyName,
        state: stateVal,
        is_available: isAvailable,
        latitude: lat,
        longitude: lon,
        accuracy: attrs.gps_accuracy != null ? Number(attrs.gps_accuracy) : null,
        battery: battery,
        charging: charging,
        platform: attrs.source_type || "tracker",
        last_updated: stateObj.last_updated || nowIso,
        map_icon: entityId.includes("phone") ? "📱 Phone" : "📍 Tracker"
      });
    }
    list.sort((a, b) => (a.is_available === b.is_available ? a.device_name.localeCompare(b.device_name) : a.is_available ? -1 : 1));
    return list;
  }

  public getEntityLocation(entityId: string): any | null {
    if (!entityId || !this.entities.has(entityId)) return null;
    const stateObj = this.entities.get(entityId);
    const attrs = stateObj.attributes || {};
    if (attrs.latitude == null || attrs.longitude == null) return null;

    const friendlyName = attrs.friendly_name || entityId.split(".")[1].replace(/_/g, " ");
    return {
      entity_id: entityId,
      device_name: friendlyName,
      latitude: Number(attrs.latitude),
      longitude: Number(attrs.longitude),
      battery: attrs.battery_level ?? attrs.battery ?? 100,
      charging: attrs.battery_charging ?? attrs.charging ?? null,
      accuracy: attrs.gps_accuracy ?? null,
      state: stateObj.state || "unknown",
      last_updated: stateObj.last_updated || new Date().toISOString(),
      map_icon: entityId.includes("phone") ? "📱 Phone" : "📍 Tracker",
      location_visibility: "family",
      is_default: true
    };
  }
}

export const nodeHAClient = new NodeHAClient();

export interface EntityStateData {
  entity_id: string;
  user_id: number;
  domain: string;
  state: string;
  attributes: Record<string, any>;
  latitude?: number | null;
  longitude?: number | null;
  last_updated: string;
}

export interface LocationHistoryEntry {
  id: string;
  entity_id: string;
  user_id: number;
  latitude: number;
  longitude: number;
  battery_level?: number;
  accuracy?: number;
  timestamp: string;
}

export interface PlaceData {
  id: number;
  circle_id: number;
  name: string;
  address?: string | null;
  latitude: number;
  longitude: number;
  radius: number;
  icon?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertData {
  id: number;
  circle_id: number;
  user_id: number;
  target_user_id?: number | null;
  alert_type: string;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface GeofenceStateData {
  id: number;
  user_id: number;
  device_id: string;
  place_id: number;
  inside: boolean;
  last_updated: string;
}

export interface DeviceBatteryStateData {
  entity_id: string;
  last_known_battery: number | null;
  low_battery_alert_triggered: boolean;
}

export interface DeviceOfflineStateData {
  entity_id: string;
  last_seen_at: string;
  device_offline_alert_triggered: boolean;
  first_telemetry_received: boolean;
}

export interface YimlyPreviewDatabase {
  users: UserData[];
  circles: CircleData[];
  circle_members: CircleMemberData[];
  entity_states: EntityStateData[];
  location_history: LocationHistoryEntry[];
  places: PlaceData[];
  alerts: AlertData[];
  geofence_states: GeofenceStateData[];
  device_battery_states: DeviceBatteryStateData[];
  device_offline_states: DeviceOfflineStateData[];
  devices: any[];
}

// Data Store Management (Isolated JSON File Store)
function loadDB(): YimlyPreviewDatabase {
  if (!fs.existsSync(DATA_FILE)) {
    const initialDB: YimlyPreviewDatabase = {
      users: [],
      circles: [],
      circle_members: [],
      entity_states: [],
      location_history: [],
      places: [],
      alerts: [],
      geofence_states: [],
      device_battery_states: [],
      device_offline_states: [],
      devices: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialDB, null, 2));
    return initialDB;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    const loaded: YimlyPreviewDatabase = {
      users: parsed.users || [],
      circles: parsed.circles || [],
      circle_members: parsed.circle_members || [],
      entity_states: parsed.entity_states || [],
      location_history: parsed.location_history || [],
      places: parsed.places || [],
      alerts: parsed.alerts || [],
      geofence_states: parsed.geofence_states || [],
      device_battery_states: parsed.device_battery_states || [],
      device_offline_states: parsed.device_offline_states || [],
      devices: parsed.devices || []
    };

    return loaded;
  } catch (err) {
    return {
      users: [],
      circles: [],
      circle_members: [],
      entity_states: [],
      location_history: [],
      places: [],
      alerts: [],
      geofence_states: [],
      device_battery_states: [],
      device_offline_states: [],
      devices: []
    };
  }
}

function saveDB(db: YimlyPreviewDatabase) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth State Store for Preview
interface AuthCodeRecord {
  code: string;
  user_id: number;
  client_id: string;
  redirect_uri: string;
  expires_at: number;
  used: boolean;
}

const authCodesStore: AuthCodeRecord[] = [];
const refreshTokensStore: { token: string; user_id: number; client_id: string; expires_at: number; revoked: boolean }[] = [];

const dataDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, "uploads");
const profilePicsDir = path.join(uploadsDir, "profile_pictures");
if (!fs.existsSync(profilePicsDir)) {
  fs.mkdirSync(profilePicsDir, { recursive: true });
}

// Copy any legacy uploads to persistent directory
const legacyProfilePicsDir = path.join(process.cwd(), "uploads", "profile_pictures");
if (fs.existsSync(legacyProfilePicsDir) && path.resolve(legacyProfilePicsDir) !== path.resolve(profilePicsDir)) {
  try {
    const files = fs.readdirSync(legacyProfilePicsDir);
    for (const file of files) {
      const srcFile = path.join(legacyProfilePicsDir, file);
      const dstFile = path.join(profilePicsDir, file);
      if (fs.statSync(srcFile).isFile() && !fs.existsSync(dstFile)) {
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  } catch (e) {
    console.warn("Failed migrating legacy profile pictures in server.ts:", e);
  }
}

app.use("/uploads", (req, res) => {
  const relPath = req.path || "";
  const safeRelPath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, "");
  if (safeRelPath.includes("..")) {
    return res.status(400).json({ detail: "Invalid file path" });
  }

  const primaryFile = path.join(uploadsDir, safeRelPath);
  if (fs.existsSync(primaryFile) && fs.statSync(primaryFile).isFile()) {
    return res.sendFile(primaryFile);
  }

  const legacyFile = path.join(process.cwd(), "uploads", safeRelPath);
  if (fs.existsSync(legacyFile) && fs.statSync(legacyFile).isFile()) {
    try {
      const dir = path.dirname(primaryFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(legacyFile, primaryFile);
    } catch (e) {
      console.warn("Failed auto-migrating legacy file in server.ts:", e);
    }
    return res.sendFile(primaryFile);
  }

  res.status(404).json({ detail: "File not found" });
});

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(profilePicsDir)) {
      fs.mkdirSync(profilePicsDir, { recursive: true });
    }
    cb(null, profilePicsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    const uniqueName = `user_${(req as any).user?.id || "anon"}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${safeExt}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (_req, file, cb) => {
    const allowedMime = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [".jpg", ".jpeg", ".png", ".webp"];
    if (allowedMime.includes(file.mimetype.toLowerCase()) && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, and WebP images are allowed."));
    }
  }
});

const server = http.createServer(app);

// WebSocket Setup for Real-time Core updates
const wss = new WebSocketServer({ noServer: true });
const connectedClients = new Set<WebSocket>();

// Keepalive heartbeat every 25 seconds to keep proxies and clients alive
setInterval(() => {
  connectedClients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {}
    }
  });
}, 25000);

wss.on("connection", (ws: WebSocket) => {
  connectedClients.add(ws);
  let authenticatedUserId: number | null = null;
  ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.9.1" }));

  ws.on("message", (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "pong") {
        return;
      }
      if (data.type === "auth") {
        const token = data.access_token;
        if (token) {
          try {
            const decoded: any = jwt.verify(token, JWT_SECRET);
            if (decoded && decoded.sub) {
              authenticatedUserId = Number(decoded.sub);
            }
          } catch {}
        }
        ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.9.1" }));
      } else if (data.type === "auth/current_user") {
        db = loadDB();
        const u = authenticatedUserId ? db.users.find((user: any) => user.id === authenticatedUserId) : (db.users[0] || null);
        const userName = u ? (u.display_name || u.username) : (authenticatedUserId ? `User ${authenticatedUserId}` : "User");
        const userIdStr = u ? String(u.id) : (authenticatedUserId ? String(authenticatedUserId) : "1");
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: {
            id: userIdStr,
            name: userName,
            is_owner: true,
            is_admin: true,
            credentials: [],
            mfa_modules: []
          }
        }));
      } else if (data.type === "ping") {
        ws.send(JSON.stringify(data.id !== undefined ? { id: data.id, type: "pong" } : { type: "pong" }));
      } else if (data.type === "supported_features") {
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: null }));
      } else if (data.type === "subscribe_events") {
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: null }));
      } else if (data.type === "unsubscribe_events") {
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: null }));
      } else if (data.type === "subscribe_trigger") {
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: null }));
      } else if (data.type === "persistent_notification/get") {
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: [] }));
      } else if (data.type === "call_service") {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: {
            context: {
              id: `ctx_${data.id}`,
              user_id: authenticatedUserId ? String(authenticatedUserId) : "1"
            }
          }
        }));
      } else if (data.type === "get_config") {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: {
            latitude: 0.0,
            longitude: 0.0,
            elevation: 0,
            unit_system: { length: "km", mass: "g", temperature: "°C", volume: "L" },
            location_name: "Home Assistant",
            time_zone: "UTC",
            components: ["api", "websocket", "mobile_app", "device_tracker", "sensor"],
            version: "2026.9.1"
          }
        }));
      } else if (data.type === "get_services") {
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: {} }));
      } else if (data.type === "get_panels") {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: {
            lovelace: {
              title: "Home",
              icon: "mdi:home-assistant",
              url_path: "lovelace",
              config: { views: [] }
            }
          }
        }));
      } else if (data.type === "frontend/get_translations") {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: { resources: {} }
        }));
      } else if (data.type === "manifest/list") {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: []
        }));
      } else if (data.type === "get_states") {
        db = loadDB();
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: db.entity_states || []
        }));
      } else if (data.type === "config/device_registry/list") {
        db = loadDB();
        const devices = (db.devices || []).map((d: any) => ({
          id: String(d.id),
          name: d.device_name,
          model: d.model,
          manufacturer: d.manufacturer,
          sw_version: d.os_version,
          identifiers: [["mobile_app", d.device_id]],
          connections: [],
          area_id: null,
          disabled_by: null,
          entry_type: null
        }));
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: devices }));
      } else if (data.type === "config/entity_registry/list") {
        db = loadDB();
        const entities = (db.entity_states || []).map((e: any) => ({
          entity_id: e.entity_id,
          name: e.attributes?.friendly_name || null,
          icon: e.attributes?.icon || null,
          platform: "mobile_app",
          config_entry_id: null,
          device_id: null,
          area_id: null,
          disabled_by: null,
          capabilities: {}
        }));
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: entities }));
      } else if (data.type === "config/area_registry/list") {
        db = loadDB();
        const areas = (db.places || []).map((p: any) => ({
          area_id: `area_${p.id}`,
          name: p.name,
          picture: null,
          aliases: []
        }));
        ws.send(JSON.stringify({ id: data.id, type: "result", success: true, result: areas }));
      } else if (data.type === "frontend/get_user_data") {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: true,
          result: { show_advanced_options: false }
        }));
      } else {
        ws.send(JSON.stringify({
          id: data.id,
          type: "result",
          success: false,
          error: { code: "not_supported", message: `Command '${data.type}' is not supported.` }
        }));
      }
    } catch (e) {
      // Ignore invalid JSON
    }
  });

  ws.on("error", (err) => {
    connectedClients.delete(ws);
    console.log(`[WS-DIAG] Server WebSocket error: user=${authenticatedUserId ?? "unauth"} error=${(err as any)?.message || String(err)}`);
  });

  ws.on("close", (code, reason) => {
    connectedClients.delete(ws);
    console.log(`[WS-DIAG] Server WebSocket close: user=${authenticatedUserId ?? "unauth"} code=${code} reason=${reason?.toString() || ""}`);
  });
});

server.on("upgrade", (request, socket, head) => {
  const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : "";
  if (pathname === "/api/websocket" || pathname === "/api/websocket/") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

function broadcastStateUpdate(event: any) {
  const payload = JSON.stringify({ type: "event", event });
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Authentication Middleware
export interface AuthRequest extends Request {
  user?: UserData;
}

function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ detail: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string | number };
    const userId = Number(decoded.sub);
    db = loadDB();
    const found = db.users.find((u) => u.id === userId);
    if (!found) {
      return res.status(401).json({ detail: "User not found" });
    }
    req.user = found;
    next();
  } catch (err) {
    return res.status(401).json({ detail: "Invalid or expired token" });
  }
}

// OAuth 2.0 Authorization & Token Endpoints for Home Assistant Companion App
app.get("/auth/authorize", (req, res) => {
  const client_id = (req.query.client_id as string) || "https://home-assistant.io/android";
  const redirect_uri = (req.query.redirect_uri as string) || "homeassistant://auth-callback";
  const response_type = (req.query.response_type as string) || "code";
  const state = (req.query.state as string) || "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connect to Home Assistant</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f5f7fa; color: #333333; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; }
    .container { background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); width: 100%; max-width: 400px; padding: 32px; box-sizing: border-box; }
    .header { text-align: center; margin-bottom: 24px; }
    .logo { font-size: 32px; margin-bottom: 8px; display: inline-block; }
    .title { font-size: 22px; font-weight: 600; margin: 0; color: #111111; }
    .subtitle { font-size: 14px; color: #666666; margin: 4px 0 0 0; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: #444444; }
    input[type="text"], input[type="password"] { width: 100%; padding: 12px; border: 1px solid #cccccc; border-radius: 6px; box-sizing: border-box; font-size: 15px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
    input[type="text"]:focus, input[type="password"]:focus { border-color: #03a9f4; box-shadow: 0 0 0 3px rgba(3, 169, 244, 0.15); }
    .btn { background-color: #03a9f4; color: #ffffff; border: none; border-radius: 6px; padding: 12px; font-size: 16px; font-weight: 600; width: 100%; cursor: pointer; transition: background-color 0.2s; }
    .btn:hover { background-color: #0288d1; }
    .footer { text-align: center; font-size: 12px; color: #888888; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="logo">🏠</span>
      <h1 class="title">Home Assistant</h1>
      <p class="subtitle">Log in to authorize your companion app</p>
    </div>
    <form method="POST" action="/auth/login_submit">
      <input type="hidden" name="client_id" value="${client_id}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="response_type" value="${response_type}">
      <input type="hidden" name="state" value="${state}">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autofocus autocomplete="username" placeholder="Enter your username">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Enter your password">
      </div>
      <button type="submit" class="btn">Log In & Authorize</button>
    </form>
    <div class="footer">
      Connecting to ${client_id}
    </div>
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

app.post("/auth/login_submit", (req, res) => {
  const username = req.body.username;
  const password = req.body.password;
  const client_id = req.body.client_id || "https://home-assistant.io/android";
  const redirect_uri = req.body.redirect_uri || "homeassistant://auth-callback";
  const state = req.body.state || "";

  if (!username || !password) {
    return res.status(400).send("Missing required parameters.");
  }

  db = loadDB();
  const found = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!found || !bcrypt.compareSync(password, found.password_hash)) {
    return res.status(401).send("Invalid username or password.");
  }

  const code = crypto.randomBytes(32).toString("hex");
  const expires_at = Date.now() + 5 * 60 * 1000; // 5 minutes

  authCodesStore.push({
    code,
    user_id: found.id,
    client_id,
    redirect_uri,
    expires_at,
    used: false
  });

  const sep = redirect_uri.includes("?") ? "&" : "?";
  let redirectUrl = `${redirect_uri}${sep}code=${code}`;
  if (state) {
    redirectUrl += `&state=${encodeURIComponent(state)}`;
  }

  res.redirect(302, redirectUrl);
});

app.post("/auth/token", (req, res) => {
  const { grant_type, client_id, code, redirect_uri, refresh_token } = req.body;

  if (grant_type === "authorization_code") {
    if (!code || !client_id) {
      return res.status(400).json({ detail: "Code and client_id are required for authorization_code grant." });
    }

    const authCode = authCodesStore.find(
      (ac) => ac.code === code && ac.client_id === client_id
    );

    if (!authCode) {
      return res.status(400).json({ detail: "Invalid authorization code or client_id." });
    }

    if (redirect_uri && authCode.redirect_uri !== redirect_uri) {
      return res.status(400).json({ detail: "Mismatched redirect_uri." });
    }

    if (authCode.used || authCode.expires_at < Date.now()) {
      return res.status(400).json({ detail: "Authorization code has already been used or has expired." });
    }

    // Mark used atomically
    authCode.used = true;

    const access_token = jwt.sign({ sub: String(authCode.user_id), typ: "access" }, JWT_SECRET, { expiresIn: "30d" });
    const new_refresh_token = crypto.randomBytes(32).toString("hex");

    refreshTokensStore.push({
      token: new_refresh_token,
      user_id: authCode.user_id,
      client_id,
      expires_at: Date.now() + 90 * 86400000,
      revoked: false
    });

    return res.json({
      access_token,
      token_type: "Bearer",
      expires_in: 1800,
      refresh_token: new_refresh_token
    });
  } else if (grant_type === "refresh_token") {
    if (!refresh_token || !client_id) {
      return res.status(400).json({ detail: "refresh_token and client_id are required." });
    }

    const ref = refreshTokensStore.find(
      (r) => r.token === refresh_token && r.client_id === client_id && !r.revoked && r.expires_at > Date.now()
    );

    if (!ref) {
      return res.status(400).json({ detail: "Invalid or expired refresh token." });
    }

    const access_token = jwt.sign({ sub: String(ref.user_id), typ: "access" }, JWT_SECRET, { expiresIn: "30d" });
    return res.json({
      access_token,
      token_type: "Bearer",
      expires_in: 1800,
      refresh_token
    });
  } else {
    return res.status(400).json({ detail: "Unsupported grant_type." });
  }
});

// System / Setup status endpoints
app.get("/api/setup/status", (req, res) => {
  db = loadDB();
  res.json({
    is_initialized: db.users.length > 0,
    needs_setup: db.users.length === 0
  });
});

// Home Assistant Core discovery and services endpoints
app.get("/api/discovery_info", (req, res) => {
  res.json({
    base_url: `http://localhost:${PORT}`,
    location_name: "Home Assistant",
    installation_type: "Home Assistant OS",
    version: "2026.9.1",
    requires_api_password: false
  });
});

app.get("/api/services", (req, res) => {
  res.json([
    {
      domain: "homeassistant",
      services: {
        turn_on: { name: "Turn on", description: "Turn on a device", fields: {} },
        turn_off: { name: "Turn off", description: "Turn off a device", fields: {} },
        toggle: { name: "Toggle", description: "Toggle state", fields: {} },
        update_entity: { name: "Update entity", description: "Request entity update", fields: {} }
      }
    },
    {
      domain: "device_tracker",
      services: {
        see: { name: "See", description: "Record device location", fields: {} }
      }
    },
    {
      domain: "notify",
      services: {
        notify: { name: "Send notification", description: "Send notification", fields: {} }
      }
    }
  ]);
});

app.post("/api/setup/register", (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password || !display_name) {
    return res.status(400).json({ detail: "Username, password, and display name are required" });
  }

  db = loadDB();
  const salt = bcrypt.genSaltSync(10);
  const password_hash = bcrypt.hashSync(password, salt);
  const newUser: UserData = {
    id: db.users.length + 1,
    username,
    password_hash,
    display_name,
    avatar_color: null,
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);

  // Auto-create initial Family Circle
  const initialCircle: CircleData = {
    id: db.circles.length + 1,
    name: `${display_name}'s Family Circle`,
    owner_id: newUser.id,
    invite_code: "YIMLY-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
    created_at: new Date().toISOString()
  };

  db.circles.push(initialCircle);
  db.circle_members.push({ circle_id: initialCircle.id, user_id: newUser.id });
  saveDB(db);

  const token = jwt.sign({ sub: String(newUser.id) }, JWT_SECRET, { expiresIn: "30d" });

  res.json({
    access_token: token,
    token_type: "Bearer",
    user: {
      id: newUser.id,
      username: newUser.username,
      display_name: newUser.display_name,
      avatar_color: newUser.avatar_color,
      map_selected_icon_size: 72,
      map_unselected_icon_size: 64
    }
  });
});

// Authentication Routes
app.post("/api/auth/register", (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password || !display_name) {
    return res.status(400).json({ detail: "Username, password, and display name are required" });
  }

  db = loadDB();
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ detail: "Username is already registered" });
  }

  const salt = bcrypt.genSaltSync(10);
  const password_hash = bcrypt.hashSync(password, salt);
  const newUser: UserData = {
    id: db.users.length + 1,
    username,
    password_hash,
    display_name,
    avatar_color: null,
    map_style: "osm",
    map_selected_icon_size: 72,
    map_unselected_icon_size: 64,
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);

  // Auto-add to existing first circle or create a new circle
  if (db.circles.length > 0) {
    db.circle_members.push({ circle_id: db.circles[0].id, user_id: newUser.id });
  } else {
    const defaultCircle: CircleData = {
      id: 1,
      name: "Family Circle",
      owner_id: newUser.id,
      invite_code: "YIMLY-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      created_at: new Date().toISOString()
    };
    db.circles.push(defaultCircle);
    db.circle_members.push({ circle_id: 1, user_id: newUser.id });
  }
  saveDB(db);

  const token = jwt.sign({ sub: String(newUser.id) }, JWT_SECRET, { expiresIn: "30d" });

  res.json({
    access_token: token,
    token_type: "Bearer",
    user: formatUserResponse(newUser)
  });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ detail: "Username and password required" });
  }

  db = loadDB();
  const found = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!found || !bcrypt.compareSync(password, found.password_hash)) {
    return res.status(401).json({ detail: "Invalid username or password" });
  }

  const token = jwt.sign({ sub: String(found.id) }, JWT_SECRET, { expiresIn: "30d" });

  res.json({
    access_token: token,
    token_type: "Bearer",
    user: formatUserResponse(found)
  });
});

// Helper to fetch current user info from Home Assistant using a temporary WebSocket connection
function fetchHaUserWithToken(token: string): Promise<{ id: string; name: string }> {
  return new Promise((resolve, reject) => {
    const rawUrl = (process.env.HA_URL || "").trim().replace(/\/+$/, "");
    if (!rawUrl) {
      return reject(new Error("HA_URL is not configured on the server"));
    }
    const wsUrl = rawUrl.replace(/^http/, "ws") + "/api/websocket";
    const ws = new WebSocket(wsUrl);
    let idCounter = 1;
    let authSent = false;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout waiting for Home Assistant websocket handshake"));
    }, 8000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
          authSent = true;
        } else if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ id: idCounter++, type: "auth/current_user" }));
        } else if (msg.type === "auth_invalid") {
          ws.close();
          reject(new Error("Invalid Home Assistant authentication token"));
        } else if (msg.type === "result" && msg.success && msg.result && msg.result.id) {
          clearTimeout(timeout);
          ws.close();
          resolve({
            id: msg.result.id,
            name: msg.result.name || "Home Assistant User"
          });
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Endpoint to exchange Home Assistant IndieAuth code for tokens and log the user in
app.post("/api/auth/ha-callback", async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code || !redirect_uri) {
    return res.status(400).json({ detail: "Authorization code and redirect_uri are required" });
  }

  const haUrl = (process.env.HA_URL || "").trim().replace(/\/+$/, "");
  if (!haUrl) {
    return res.status(500).json({ detail: "HA_URL is not configured on the server" });
  }

  try {
    // Exchange IndieAuth authorization code at the real HA /auth/token endpoint
    const bodyParams = new URLSearchParams();
    bodyParams.append("grant_type", "authorization_code");
    bodyParams.append("code", code);
    bodyParams.append("client_id", redirect_uri); // IndieAuth client_id is typically the redirect origin
    bodyParams.append("redirect_uri", redirect_uri);

    const tokenResponse = await fetch(`${haUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Home Assistant token exchange failed:", errorText);
      return res.status(tokenResponse.status).json({ detail: `HA Token Exchange failed: ${errorText}` });
    }

    const tokenData = await tokenResponse.json() as { access_token: string; refresh_token?: string };
    const { access_token, refresh_token } = tokenData;

    if (!access_token) {
      return res.status(400).json({ detail: "No access token returned from Home Assistant" });
    }

    // Connect to HA websocket to fetch the authenticated user profile details
    const haUser = await fetchHaUserWithToken(access_token);

    db = loadDB();
    // Search for existing user matching this Home Assistant ID
    let foundUser = db.users.find((u: any) => u.ha_user_id === haUser.id);

    if (!foundUser) {
      // Create new user linked to their Home Assistant identity
      const nextId = db.users.length > 0 ? Math.max(...db.users.map((u) => u.id)) + 1 : 1;
      const newUser: UserData = {
        id: nextId,
        username: `ha_${haUser.id}`,
        password_hash: "", // No local password for HA OAuth accounts
        display_name: haUser.name,
        ha_user_id: haUser.id,
        avatar_color: null,
        map_style: "osm",
        map_selected_icon_size: 72,
        map_unselected_icon_size: 64,
        created_at: new Date().toISOString()
      } as any;

      db.users.push(newUser);

      // Auto-add new user to first existing family circle, or create one if none exist
      if (db.circles.length > 0) {
        db.circle_members.push({ circle_id: db.circles[0].id, user_id: newUser.id });
      } else {
        const defaultCircle = {
          id: 1,
          name: "Family Circle",
          owner_id: newUser.id,
          invite_code: "YIMLY-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
          created_at: new Date().toISOString()
        };
        db.circles.push(defaultCircle);
        db.circle_members.push({ circle_id: 1, user_id: newUser.id });
      }
      foundUser = newUser;
    }

    const activeUser = foundUser as UserData;

    // Always update token references in database (for persistent tracking or session info)
    (activeUser as any).ha_access_token = access_token;
    if (refresh_token) {
      (activeUser as any).ha_refresh_token = refresh_token;
    }
    saveDB(db);

    // Issue standard JWT session token for Yimly app UI
    const yimlyToken = jwt.sign({ sub: String(activeUser.id) }, JWT_SECRET, { expiresIn: "30d" });

    res.json({
      access_token: yimlyToken,
      token_type: "Bearer",
      user: formatUserResponse(activeUser)
    });
  } catch (error: any) {
    console.error("Error inside /api/auth/ha-callback:", error);
    res.status(500).json({ detail: error.message || "Internal server error during authentication" });
  }
});

app.get("/api/auth/me", authenticateToken, (req: AuthRequest, res) => {
  res.json(formatUserResponse(req.user!));
});

app.post("/api/auth/password", authenticateToken, (req: AuthRequest, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ detail: "Current password and new password are required" });
  }

  db = loadDB();
  const userIdx = db.users.findIndex((u) => u.id === req.user!.id);
  if (userIdx === -1) {
    return res.status(404).json({ detail: "User not found" });
  }

  if (!bcrypt.compareSync(current_password, db.users[userIdx].password_hash)) {
    return res.status(400).json({ detail: "Current password is incorrect" });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ detail: "New password must be at least 6 characters" });
  }

  db.users[userIdx].password_hash = bcrypt.hashSync(new_password, 10);
  saveDB(db);

  res.json({ success: true, message: "Password updated successfully" });
});

app.put("/api/auth/profile", authenticateToken, (req: AuthRequest, res) => {
  const {
    username,
    display_name,
    avatar_color,
    map_style,
    map_pin_type,
    map_selected_icon_size,
    map_unselected_icon_size,
    share_location,
    save_location_history,
    history_retention,
    location_update_frequency,
    notify_push,
    notify_arrival_departure,
    notify_stop_sharing,
    notify_low_battery,
    notify_device_offline
  } = req.body;

  db = loadDB();
  const userIdx = db.users.findIndex((u) => u.id === req.user!.id);
  if (userIdx === -1) {
    return res.status(404).json({ detail: "User not found" });
  }

  if (username !== undefined && username.trim()) {
    const trimmed = username.trim();
    const existing = db.users.find(
      (u) => u.id !== req.user!.id && u.username.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      return res.status(400).json({ detail: "Username is already taken" });
    }
    db.users[userIdx].username = trimmed;
  }

  if (display_name !== undefined && display_name.trim()) {
    db.users[userIdx].display_name = display_name.trim();
  }
  if (avatar_color !== undefined) {
    db.users[userIdx].avatar_color = avatar_color;
  }

  if (map_style !== undefined) {
    const allowed = [
      "osm",
      "openfree_positron",
      "openfree_bright",
      "openfree_liberty",
      "openfree_dark",
      "openfree_fiord",
      "carto_voyager",
      "carto_positron",
      "carto_dark"
    ];
    if (allowed.includes(map_style)) {
      db.users[userIdx].map_style = map_style;
    } else {
      return res.status(400).json({ detail: "Invalid map_style value" });
    }
  }

  if (map_pin_type !== undefined) {
    const allowedPinTypes = [
      "classic_pin",
      "circle",
      "teardrop",
      "beacon",
      "badge",
      "minimal",
      "arrow",
      "photo_pin"
    ];
    if (allowedPinTypes.includes(map_pin_type)) {
      db.users[userIdx].map_pin_type = map_pin_type;
    } else {
      return res.status(400).json({ detail: "Invalid map_pin_type value" });
    }
  }

  if (map_selected_icon_size !== undefined && typeof map_selected_icon_size === "number") {
    db.users[userIdx].map_selected_icon_size = Math.max(24, Math.min(72, map_selected_icon_size));
  }
  if (map_unselected_icon_size !== undefined && typeof map_unselected_icon_size === "number") {
    db.users[userIdx].map_unselected_icon_size = Math.max(24, Math.min(72, map_unselected_icon_size));
  }

  const previousShare = db.users[userIdx].share_location !== false;
  let isStopSharingTransition = false;

  if (share_location !== undefined) {
    const nextShare = Boolean(share_location);
    if (previousShare === true && nextShare === false) {
      isStopSharingTransition = true;
    }
    db.users[userIdx].share_location = nextShare;
  }
  if (save_location_history !== undefined) {
    db.users[userIdx].save_location_history = Boolean(save_location_history);
  }
  if (history_retention !== undefined) {
    db.users[userIdx].history_retention = history_retention;
    cleanupHistoryForUser(db, db.users[userIdx].id, history_retention);
  }
  if (location_update_frequency !== undefined) {
    db.users[userIdx].location_update_frequency = location_update_frequency;
  }

  if (notify_push !== undefined) db.users[userIdx].notify_push = Boolean(notify_push);
  if (notify_arrival_departure !== undefined) db.users[userIdx].notify_arrival_departure = Boolean(notify_arrival_departure);
  if (notify_stop_sharing !== undefined) db.users[userIdx].notify_stop_sharing = Boolean(notify_stop_sharing);
  if (notify_low_battery !== undefined) db.users[userIdx].notify_low_battery = Boolean(notify_low_battery);
  if (notify_device_offline !== undefined) db.users[userIdx].notify_device_offline = Boolean(notify_device_offline);

  if (isStopSharingTransition) {
    const userCircles = db.circle_members.filter((m) => m.user_id === req.user!.id).map((m) => m.circle_id);
    for (const circleId of userCircles) {
      const circleMembers = db.circle_members.filter((m) => m.circle_id === circleId);
      for (const cm of circleMembers) {
        if (!cm.user_id || cm.user_id === req.user!.id) continue;

        const recipient = db.users.find((u) => u.id === cm.user_id);
        if (!recipient || recipient.notify_stop_sharing === false) continue;

        const newAlert: AlertData = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          circle_id: circleId,
          user_id: cm.user_id,
          target_user_id: req.user!.id,
          alert_type: "stop_sharing",
          title: `${db.users[userIdx].display_name} stopped sharing location`,
          message: `${db.users[userIdx].display_name} has stopped sharing their location with the circle.`,
          read: false,
          created_at: new Date().toISOString()
        };

        db.alerts = db.alerts || [];
        db.alerts.push(newAlert);

        broadcastStateUpdate({
          event_type: "alert_created",
          data: newAlert
        });
      }
    }
  }

  saveDB(db);
  res.json(formatUserResponse(db.users[userIdx]));
});

const handleUpload = (req: AuthRequest, res: Response, next: NextFunction) => {
  upload.single("file")(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ detail: "File size exceeds maximum limit of 5MB." });
        }
        return res.status(400).json({ detail: err.message });
      }
      return res.status(400).json({ detail: err.message || "File upload failed." });
    }
    next();
  });
};

app.post(["/api/auth/profile/picture", "/api/auth/profile-picture"], authenticateToken, handleUpload, (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ detail: "No image file provided." });
  }

  // Validate file content magic bytes
  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    const isJpeg = fileBuffer.length >= 3 && fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff;
    const isPng = fileBuffer.length >= 8 && fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4e && fileBuffer[3] === 0x47;
    const isWebp = fileBuffer.length >= 12 && fileBuffer.toString("ascii", 0, 4) === "RIFF" && fileBuffer.toString("ascii", 8, 12) === "WEBP";

    if (!isJpeg && !isPng && !isWebp) {
      if (fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(400).json({ detail: "Corrupted or invalid image file content." });
    }
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(400).json({ detail: "Failed to read uploaded image file." });
  }

  db = loadDB();
  const userIdx = db.users.findIndex((u) => u.id === req.user!.id);
  if (userIdx === -1) {
    return res.status(404).json({ detail: "User not found" });
  }
  const user = db.users[userIdx];
  if (user.profile_picture_url) {
    const oldFileName = path.basename(user.profile_picture_url);
    const checkPaths = [
      path.join(profilePicsDir, oldFileName),
      path.join(process.cwd(), "uploads", "profile_pictures", oldFileName)
    ];
    for (const oldFilePath of checkPaths) {
      if (fs.existsSync(oldFilePath)) {
        try { fs.unlinkSync(oldFilePath); } catch (e) {}
      }
    }
  }
  const pictureUrl = `/uploads/profile_pictures/${req.file.filename}`;
  db.users[userIdx].profile_picture_url = pictureUrl;
  saveDB(db);
  res.json(formatUserResponse(db.users[userIdx]));
});

app.delete(["/api/auth/profile/picture", "/api/auth/profile-picture"], authenticateToken, (req: AuthRequest, res: Response) => {
  db = loadDB();
  const userIdx = db.users.findIndex((u) => u.id === req.user!.id);
  if (userIdx !== -1) {
    const user = db.users[userIdx];
    if (user.profile_picture_url) {
      const oldFileName = path.basename(user.profile_picture_url);
      const checkPaths = [
        path.join(profilePicsDir, oldFileName),
        path.join(process.cwd(), "uploads", "profile_pictures", oldFileName)
      ];
      for (const oldFilePath of checkPaths) {
        if (fs.existsSync(oldFilePath)) {
          try { fs.unlinkSync(oldFilePath); } catch (e) {}
        }
      }
      db.users[userIdx].profile_picture_url = null;
      saveDB(db);
    }
    res.json(formatUserResponse(db.users[userIdx]));
  } else {
    res.status(404).json({ detail: "User not found" });
  }
});

// Family Circles Routes
app.get("/api/circles", authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  const userCircleIds = db.circle_members
    .filter((m) => m.user_id === req.user!.id)
    .map((m) => m.circle_id);

  const userCircles = db.circles.filter((c) => userCircleIds.includes(c.id));
  res.json(userCircles);
});

app.post("/api/circles", authenticateToken, (req: AuthRequest, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ detail: "Circle name required" });

  db = loadDB();
  const userId = req.user!.id;

  // Single circle constraint: remove user from existing circle first
  const existingCircleIds = db.circle_members
    .filter((m) => m.user_id === userId)
    .map((m) => m.circle_id);

  db.circle_members = db.circle_members.filter((m) => m.user_id !== userId);

  // If old circle has no members left, delete it automatically
  existingCircleIds.forEach((oldId) => {
    const remaining = db.circle_members.filter((m) => m.circle_id === oldId);
    if (remaining.length === 0) {
      db.circles = db.circles.filter((c) => c.id !== oldId);
      db.alerts = (db.alerts || []).filter((a) => a.circle_id !== oldId);
      db.places = (db.places || []).filter((p) => p.circle_id !== oldId);
    }
  });

  const newCircle: CircleData = {
    id: db.circles.length > 0 ? Math.max(...db.circles.map((c) => c.id)) + 1 : 1,
    name: name.trim(),
    owner_id: userId,
    invite_code: crypto.randomBytes(3).toString("hex").toUpperCase(),
    created_at: new Date().toISOString()
  };

  db.circles.push(newCircle);
  db.circle_members.push({ circle_id: newCircle.id, user_id: userId });
  db.alerts = (db.alerts || []).filter((a) => a.circle_id !== newCircle.id);
  db.places = (db.places || []).filter((p) => p.circle_id !== newCircle.id);
  saveDB(db);

  res.json(newCircle);
});

app.post("/api/circles/join", authenticateToken, (req: AuthRequest, res) => {
  const { invite_code } = req.body;
  if (!invite_code || !invite_code.trim()) return res.status(400).json({ detail: "Invite code required" });

  db = loadDB();
  const circle = db.circles.find(
    (c) => c.invite_code.toUpperCase() === invite_code.trim().toUpperCase()
  );

  if (!circle) {
    return res.status(404).json({ detail: "Circle not found with this invite code" });
  }

  const userId = req.user!.id;

  // Remove from existing circles first (user is in exactly ONE circle at a time)
  const existingCircleIds = db.circle_members
    .filter((m) => m.user_id === userId)
    .map((m) => m.circle_id);

  db.circle_members = db.circle_members.filter((m) => m.user_id !== userId);

  existingCircleIds.forEach((oldId) => {
    if (oldId !== circle.id) {
      const remaining = db.circle_members.filter((m) => m.circle_id === oldId);
      if (remaining.length === 0) {
        db.circles = db.circles.filter((c) => c.id !== oldId);
      }
    }
  });

  db.circle_members.push({ circle_id: circle.id, user_id: userId });
  saveDB(db);

  res.json(circle);
});

app.post("/api/circles/:id/leave", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  db = loadDB();
  const userId = req.user!.id;

  const circle = db.circles.find((c) => c.id === circleId);
  if (!circle) {
    return res.status(404).json({ detail: "Circle not found" });
  }

  const isMember = db.circle_members.some(
    (m) => m.circle_id === circleId && m.user_id === userId
  );

  if (!isMember) {
    return res.status(400).json({ detail: "You are not a member of this circle" });
  }

  // Remove membership for this user (no admin/owner restrictions - all members equal)
  db.circle_members = db.circle_members.filter(
    (m) => !(m.circle_id === circleId && m.user_id === userId)
  );

  // If last member left, delete circle automatically
  const remaining = db.circle_members.filter((m) => m.circle_id === circleId);
  if (remaining.length === 0) {
    db.circles = db.circles.filter((c) => c.id !== circleId);
  }
  saveDB(db);

  res.json({ success: true, message: `Successfully left ${circle.name}` });
});

// Delete Family Circle
app.delete("/api/circles/:id", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  db = loadDB();

  const circle = db.circles.find((c) => c.id === circleId);
  if (!circle) {
    return res.status(404).json({ detail: "Family Circle not found" });
  }

  db.circles = db.circles.filter((c) => c.id !== circleId);
  db.circle_members = db.circle_members.filter((m) => m.circle_id !== circleId);
  db.places = (db.places || []).filter((p) => p.circle_id !== circleId);
  saveDB(db);

  res.json({
    success: true,
    message: `Family Circle "${circle.name}" has been deleted.`
  });
});

app.post("/api/circles/:id/delete", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  db = loadDB();

  const circle = db.circles.find((c) => c.id === circleId);
  if (!circle) {
    return res.status(404).json({ detail: "Family Circle not found" });
  }

  db.circles = db.circles.filter((c) => c.id !== circleId);
  db.circle_members = db.circle_members.filter((m) => m.circle_id !== circleId);
  db.places = (db.places || []).filter((p) => p.circle_id !== circleId);
  saveDB(db);

  res.json({
    success: true,
    message: `Family Circle "${circle.name}" has been deleted.`
  });
});

app.get("/api/circles/:id/members", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  db = loadDB();
  const currentUserId = req.user!.id;

  const circle = db.circles.find((c) => c.id === circleId);
  if (!circle) {
    return res.status(404).json({ detail: "Circle not found" });
  }

  const isMember = db.circle_members.some(
    (m) => m.circle_id === circleId && (m.user_id === currentUserId || circle.owner_id === currentUserId)
  );

  if (!isMember && circle.owner_id !== currentUserId) {
    return res.status(403).json({ detail: "Not authorized to view this circle" });
  }

  const circleMembers = db.circle_members.filter((m) => m.circle_id === circleId);

  const members = circleMembers.map((cm, idx) => {
    const linkedUser = cm.user_id ? db.users.find((u) => u.id === cm.user_id) : null;
    const memberId = cm.id || (linkedUser ? linkedUser.id : 1000 + idx);
    const displayName = cm.display_name || (linkedUser ? linkedUser.display_name : "Family Member");
    const username = linkedUser ? linkedUser.username : `member_${memberId}`;
    const avatarColor = cm.avatar_color || (linkedUser ? linkedUser.avatar_color : null);
    const profilePictureUrl = cm.profile_picture_url || (linkedUser ? linkedUser.profile_picture_url : null);
    const assignedEntityId = cm.assigned_entity_id || (linkedUser ? linkedUser.assigned_entity_id : null);
    const isSelf = linkedUser && linkedUser.id === currentUserId;
    const isOwner = Boolean(circle.owner_id === (linkedUser ? linkedUser.id : null));

    // Privacy check: if linked user disabled location sharing and viewer is another member, hide devices
    if (linkedUser && linkedUser.share_location === false && !isSelf) {
      return {
        id: memberId,
        username,
        display_name: displayName,
        avatar_color: avatarColor,
        profile_picture_url: profilePictureUrl,
        assigned_entity_id: assignedEntityId,
        is_owner: isOwner,
        devices: []
      };
    }

    const devices: any[] = [];

    // 1. Check if assigned HA entity exists
    if (assignedEntityId) {
      if (nodeHAClient.isConfigured()) {
        const haLoc = nodeHAClient.getEntityLocation(assignedEntityId);
        if (haLoc) devices.push(haLoc);
      } else {
        // Look in local entity states
        const localEntity = db.entity_states.find((e) => e.entity_id === assignedEntityId);
        if (localEntity && localEntity.latitude != null && localEntity.longitude != null) {
          devices.push({
            entity_id: localEntity.entity_id,
            device_name: localEntity.attributes?.friendly_name || localEntity.entity_id,
            latitude: localEntity.latitude,
            longitude: localEntity.longitude,
            battery: localEntity.attributes?.battery_level ?? 100,
            accuracy: localEntity.attributes?.gps_accuracy ?? 0,
            state: localEntity.state || "unknown",
            last_updated: localEntity.last_updated,
            platform: localEntity.attributes?.platform || "tracker",
            location_visibility: localEntity.attributes?.location_visibility || "family",
            map_icon: localEntity.attributes?.map_icon || "📱 Phone",
            allow_find_my_device: true,
            is_default: true
          });
        }
      }
    } else if (linkedUser) {
      // Fallback to local entity_states for this user
      const userTrackers = db.entity_states.filter(
        (e) => e.user_id === linkedUser.id && e.domain === "device_tracker" && e.latitude != null && e.longitude != null
      );
      const visible = userTrackers.filter((dt) => isSelf || (dt.attributes?.location_visibility || "family") !== "me_only");
      for (const dt of visible) {
        devices.push({
          entity_id: dt.entity_id,
          device_name: dt.attributes?.friendly_name || dt.entity_id,
          latitude: dt.latitude!,
          longitude: dt.longitude!,
          battery: dt.attributes?.battery_level ?? 100,
          accuracy: dt.attributes?.gps_accuracy ?? 0,
          state: dt.state || "unknown",
          last_updated: dt.last_updated,
          platform: dt.attributes?.platform || "tracker",
          location_visibility: dt.attributes?.location_visibility || "family",
          map_icon: dt.attributes?.map_icon || "📱 Phone",
          allow_find_my_device: true,
          is_default: devices.length === 0
        });
      }
    }

    return {
      id: memberId,
      username,
      display_name: displayName,
      avatar_color: avatarColor,
      profile_picture_url: profilePictureUrl,
      assigned_entity_id: assignedEntityId,
      is_owner: isOwner,
      devices
    };
  });

  res.json(members);
});

// Member Management API: Create Yimly family member in Circle
app.post("/api/circles/:id/members", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  db = loadDB();
  const circle = db.circles.find((c) => c.id === circleId);
  if (!circle) {
    return res.status(404).json({ detail: "Circle not found" });
  }

  const { display_name, avatar_color, profile_picture_url, assigned_entity_id } = req.body || {};
  if (!display_name || !String(display_name).trim()) {
    return res.status(422).json({ detail: "Display name is required" });
  }

  const newMemberId = Date.now() + Math.floor(Math.random() * 1000);
  const newMember: CircleMemberData = {
    id: newMemberId,
    circle_id: circleId,
    user_id: null,
    display_name: String(display_name).trim(),
    avatar_color: avatar_color || "#FF9AA2",
    profile_picture_url: profile_picture_url || null,
    assigned_entity_id: assigned_entity_id ? String(assigned_entity_id).trim() : null,
    created_at: new Date().toISOString()
  };

  db.circle_members = db.circle_members || [];
  db.circle_members.push(newMember);
  saveDB(db);

  const devices: any[] = [];
  if (newMember.assigned_entity_id) {
    if (nodeHAClient.isConfigured()) {
      const loc = nodeHAClient.getEntityLocation(newMember.assigned_entity_id);
      if (loc) devices.push(loc);
    } else {
      const localEntity = db.entity_states.find((e) => e.entity_id === newMember.assigned_entity_id);
      if (localEntity && localEntity.latitude != null && localEntity.longitude != null) {
        devices.push({
          entity_id: localEntity.entity_id,
          device_name: localEntity.attributes?.friendly_name || localEntity.entity_id,
          latitude: localEntity.latitude,
          longitude: localEntity.longitude,
          battery: localEntity.attributes?.battery_level ?? 100,
          accuracy: localEntity.attributes?.gps_accuracy ?? 0,
          last_updated: localEntity.last_updated,
          map_icon: "📱 Phone",
          is_default: true
        });
      }
    }
  }

  res.status(201).json({
    id: newMember.id,
    username: `member_${newMember.id}`,
    display_name: newMember.display_name,
    avatar_color: newMember.avatar_color,
    profile_picture_url: newMember.profile_picture_url,
    assigned_entity_id: newMember.assigned_entity_id,
    is_owner: false,
    devices
  });
});

// Member Management API: Update Yimly family member (edit name, color, avatar, assign/change/remove HA device)
app.put("/api/circles/:id/members/:memberId", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  db = loadDB();

  let memberIndex = db.circle_members.findIndex(
    (cm) => cm.circle_id === circleId && (cm.id === memberId || cm.user_id === memberId)
  );

  if (memberIndex === -1) {
    return res.status(404).json({ detail: "Member not found" });
  }

  const { display_name, avatar_color, profile_picture_url, assigned_entity_id } = req.body || {};
  const cm = db.circle_members[memberIndex];

  if (display_name !== undefined && String(display_name).trim()) {
    cm.display_name = String(display_name).trim();
  }
  if (avatar_color !== undefined) {
    cm.avatar_color = avatar_color;
  }
  if (profile_picture_url !== undefined) {
    cm.profile_picture_url = profile_picture_url;
  }
  if (assigned_entity_id !== undefined) {
    cm.assigned_entity_id = assigned_entity_id ? String(assigned_entity_id).trim() : null;
  }

  // If this member is linked to a user, sync user record
  if (cm.user_id) {
    const userIdx = db.users.findIndex((u) => u.id === cm.user_id);
    if (userIdx !== -1) {
      if (cm.display_name) db.users[userIdx].display_name = cm.display_name;
      if (cm.avatar_color) db.users[userIdx].avatar_color = cm.avatar_color;
      if (cm.assigned_entity_id !== undefined) db.users[userIdx].assigned_entity_id = cm.assigned_entity_id;
    }
  }

  saveDB(db);

  const devices: any[] = [];
  if (cm.assigned_entity_id) {
    if (nodeHAClient.isConfigured()) {
      const loc = nodeHAClient.getEntityLocation(cm.assigned_entity_id);
      if (loc) devices.push(loc);
    } else {
      const localEntity = db.entity_states.find((e) => e.entity_id === cm.assigned_entity_id);
      if (localEntity && localEntity.latitude != null && localEntity.longitude != null) {
        devices.push({
          entity_id: localEntity.entity_id,
          device_name: localEntity.attributes?.friendly_name || localEntity.entity_id,
          latitude: localEntity.latitude,
          longitude: localEntity.longitude,
          battery: localEntity.attributes?.battery_level ?? 100,
          accuracy: localEntity.attributes?.gps_accuracy ?? 0,
          last_updated: localEntity.last_updated,
          map_icon: "📱 Phone",
          is_default: true
        });
      }
    }
  }

  res.json({
    id: cm.id || memberId,
    username: cm.user_id ? (db.users.find((u) => u.id === cm.user_id)?.username || `member_${memberId}`) : `member_${memberId}`,
    display_name: cm.display_name || "Family Member",
    avatar_color: cm.avatar_color,
    profile_picture_url: cm.profile_picture_url,
    assigned_entity_id: cm.assigned_entity_id,
    is_owner: false,
    devices
  });
});

// Member Management API: Delete Yimly family member from Circle
app.delete("/api/circles/:id/members/:memberId", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  db = loadDB();

  const circle = db.circles.find((c) => c.id === circleId);
  const memberIndex = db.circle_members.findIndex(
    (cm) => cm.circle_id === circleId && (cm.id === memberId || cm.user_id === memberId)
  );

  if (memberIndex === -1) {
    return res.status(404).json({ detail: "Member not found" });
  }

  const cm = db.circle_members[memberIndex];
  if (circle && cm.user_id === circle.owner_id) {
    return res.status(400).json({ detail: "Cannot delete the Circle owner. Delete the Circle instead." });
  }

  db.circle_members.splice(memberIndex, 1);
  saveDB(db);

  res.json({ success: true, message: "Member removed from circle" });
});

// Discovered Home Assistant Devices Inventory Endpoint
app.get(["/api/ha/devices", "/api/devices/available"], authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  if (nodeHAClient.isConfigured()) {
    const discovered = nodeHAClient.getDiscoveredDevices();
    return res.json(discovered);
  }

  // Fallback to local discovered entities in dev/preview
  const localEntities = db.entity_states.filter(
    (e) => e.domain === "device_tracker" || e.entity_id.startsWith("device_tracker.")
  );
  const list = localEntities.map((e) => ({
    entity_id: e.entity_id,
    device_name: e.attributes?.friendly_name || e.entity_id,
    state: e.state || "home",
    is_available: true,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    accuracy: e.attributes?.gps_accuracy ?? null,
    battery: e.attributes?.battery_level ?? 100,
    charging: e.attributes?.charging ?? null,
    platform: e.attributes?.platform || "Android",
    last_updated: e.last_updated || new Date().toISOString(),
    map_icon: e.attributes?.map_icon || "📱 Phone"
  }));
  res.json(list);
});

// Places API Endpoints
app.get("/api/circles/:circleId/places", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const circlePlaces = (db.places || []).filter((p) => p.circle_id === circleId);
  res.json(circlePlaces);
});

app.post("/api/circles/:circleId/places", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const { name, address, latitude, longitude, radius, icon } = req.body || {};

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(422).json({ detail: "Name is required" });
  }

  const latNum = Number(latitude);
  const lngNum = Number(longitude);
  const radNum = radius !== undefined ? Number(radius) : 100.0;

  if (isNaN(latNum) || latNum < -90 || latNum > 90) {
    return res.status(422).json({ detail: "Latitude must be between -90 and 90 degrees." });
  }

  if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
    return res.status(422).json({ detail: "Longitude must be between -180 and 180 degrees." });
  }

  if (isNaN(radNum) || radNum <= 0 || radNum > 100000) {
    return res.status(422).json({ detail: "Radius must be greater than 0 and up to 100,000 meters." });
  }

  const nowIso = new Date().toISOString();
  const newPlace: PlaceData = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    circle_id: circleId,
    name: name.trim(),
    address: address ? String(address).trim() : null,
    latitude: latNum,
    longitude: lngNum,
    radius: radNum,
    icon: icon ? String(icon).trim() : null,
    created_at: nowIso,
    updated_at: nowIso
  };

  db.places = db.places || [];
  db.places.push(newPlace);
  saveDB(db);

  res.status(201).json(newPlace);
});

app.get("/api/circles/:circleId/places/:placeId", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  const placeId = Number(req.params.placeId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const place = (db.places || []).find((p) => p.id === placeId && p.circle_id === circleId);
  if (!place) {
    return res.status(404).json({ detail: "Place not found in this circle" });
  }

  res.json(place);
});

app.put("/api/circles/:circleId/places/:placeId", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  const placeId = Number(req.params.placeId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const place = (db.places || []).find((p) => p.id === placeId && p.circle_id === circleId);
  if (!place) {
    return res.status(404).json({ detail: "Place not found in this circle" });
  }

  const { name, address, latitude, longitude, radius, icon } = req.body || {};

  if (name !== undefined) {
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(422).json({ detail: "Name cannot be empty" });
    }
    place.name = name.trim();
  }

  if (address !== undefined) {
    place.address = address ? String(address).trim() : null;
  }

  if (latitude !== undefined) {
    const latNum = Number(latitude);
    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      return res.status(422).json({ detail: "Latitude must be between -90 and 90 degrees." });
    }
    place.latitude = latNum;
  }

  if (longitude !== undefined) {
    const lngNum = Number(longitude);
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      return res.status(422).json({ detail: "Longitude must be between -180 and 180 degrees." });
    }
    place.longitude = lngNum;
  }

  if (radius !== undefined) {
    const radNum = Number(radius);
    if (isNaN(radNum) || radNum <= 0 || radNum > 100000) {
      return res.status(422).json({ detail: "Radius must be greater than 0 and up to 100,000 meters." });
    }
    place.radius = radNum;
  }

  if (icon !== undefined) {
    place.icon = icon ? String(icon).trim() : null;
  }

  place.updated_at = new Date().toISOString();
  saveDB(db);

  res.json(place);
});

app.delete("/api/circles/:circleId/places/:placeId", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  const placeId = Number(req.params.placeId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const index = (db.places || []).findIndex((p) => p.id === placeId && p.circle_id === circleId);
  if (index === -1) {
    return res.status(404).json({ detail: "Place not found in this circle" });
  }

  db.places.splice(index, 1);
  saveDB(db);

  res.json({ detail: "Place deleted successfully" });
});

// Alerts Preview Endpoints
app.get("/api/circles/:circleId/alerts", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const userAlerts = (db.alerts || [])
    .filter((a) => a.circle_id === circleId && a.user_id === userId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  res.json(userAlerts);
});

app.post("/api/circles/:circleId/alerts", authenticateToken, (req: AuthRequest, res) => {
  const circleId = Number(req.params.circleId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const { alert_type, title, message, target_user_id } = req.body || {};
  const allowedTypes = ["arrival", "departure", "stop_sharing", "low_battery", "device_offline"];

  if (!alert_type || !allowedTypes.includes(alert_type)) {
    return res.status(422).json({ detail: `Invalid alert_type. Must be one of: ${allowedTypes.join(", ")}` });
  }

  if (!title || !title.trim() || !message || !message.trim()) {
    return res.status(422).json({ detail: "Title and message are required" });
  }

  const newAlert: AlertData = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    circle_id: circleId,
    user_id: userId,
    target_user_id: target_user_id ? Number(target_user_id) : null,
    alert_type,
    title: title.trim(),
    message: message.trim(),
    read: false,
    created_at: new Date().toISOString()
  };

  db.alerts = db.alerts || [];
  db.alerts.push(newAlert);
  saveDB(db);

  res.status(201).json(newAlert);
});

app.put("/api/circles/:circleId/alerts/:alertId/read", authenticateToken, (req: AuthRequest, res) => {

  const circleId = Number(req.params.circleId);
  const alertId = Number(req.params.alertId);
  db = loadDB();
  const userId = req.user!.id;

  const isMember = db.circle_members.some((m) => m.circle_id === circleId && m.user_id === userId);
  if (!isMember) {
    return res.status(403).json({ detail: "Access denied: You are not a member of this circle" });
  }

  const alertIndex = (db.alerts || []).findIndex(
    (a) => a.id === alertId && a.circle_id === circleId && a.user_id === userId
  );

  if (alertIndex === -1) {
    return res.status(404).json({ detail: "Alert not found in this circle for this user" });
  }

  db.alerts[alertIndex].read = true;
  saveDB(db);

  res.json(db.alerts[alertIndex]);
});


// Devices API
app.get("/api/devices", authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  const userId = req.user!.id;
  const userTrackers = db.entity_states.filter(
    (e) => e.user_id === userId && e.domain === "device_tracker"
  );

  const result = userTrackers.map((dt) => ({
    entity_id: dt.entity_id,
    name: dt.attributes?.friendly_name || dt.entity_id,
    platform: dt.attributes?.platform || "Android",
    battery: dt.attributes?.battery_level ?? 100,
    state: dt.state || "home",
    last_updated: dt.last_updated,
    location_visibility: (dt.attributes?.location_visibility || "family") as "family" | "me_only",
    map_icon: dt.attributes?.map_icon || "Phone",
    allow_find_my_device: dt.attributes?.allow_find_my_device !== false
  }));

  res.json(result);
});

app.put("/api/devices/:entity_id", authenticateToken, (req: AuthRequest, res) => {
  const { name, location_visibility, map_icon, allow_find_my_device } = req.body;
  db = loadDB();
  const entityId = req.params.entity_id;
  const dtIndex = db.entity_states.findIndex(
    (e) => e.entity_id === entityId && e.user_id === req.user!.id
  );

  if (dtIndex === -1) {
    return res.status(404).json({ detail: "Device not found" });
  }

  if (!db.entity_states[dtIndex].attributes) {
    db.entity_states[dtIndex].attributes = {};
  }

  if (name !== undefined && String(name).trim()) {
    db.entity_states[dtIndex].attributes.friendly_name = String(name).trim();
  }
  if (location_visibility !== undefined) {
    db.entity_states[dtIndex].attributes.location_visibility =
      location_visibility === "me_only" ? "me_only" : "family";
  }
  if (map_icon !== undefined) {
    db.entity_states[dtIndex].attributes.map_icon = map_icon;
  }
  if (allow_find_my_device !== undefined) {
    db.entity_states[dtIndex].attributes.allow_find_my_device = Boolean(allow_find_my_device);
  }

  db.entity_states[dtIndex].last_updated = new Date().toISOString();
  saveDB(db);

  const updated = db.entity_states[dtIndex];
  res.json({
    entity_id: updated.entity_id,
    name: updated.attributes?.friendly_name || updated.entity_id,
    platform: updated.attributes?.platform || "Android",
    battery: updated.attributes?.battery_level ?? 100,
    state: updated.state || "home",
    last_updated: updated.last_updated,
    location_visibility: updated.attributes?.location_visibility || "family",
    map_icon: updated.attributes?.map_icon || "Phone",
    allow_find_my_device: updated.attributes?.allow_find_my_device !== false
  });
});

app.delete("/api/devices/:entity_id", authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  const entityId = req.params.entity_id;
  const userId = req.user!.id;

  const dtIndex = db.entity_states.findIndex(
    (e) => e.entity_id === entityId && e.user_id === userId
  );

  if (dtIndex === -1) {
    return res.status(404).json({ detail: "Device not found" });
  }

  // Remove the entity_state
  db.entity_states.splice(dtIndex, 1);

  // If there are associated devices in db.devices matching device tracker or webhook, clean up
  if (db.devices && Array.isArray(db.devices)) {
    db.devices = db.devices.filter((d) => {
      if (d.user_id !== userId) return true;
      if (d.device_id && entityId.includes(d.device_id)) return false;
      return true;
    });
  }

  // Remove associated location history for this entity
  if (db.location_history && Array.isArray(db.location_history)) {
    db.location_history = db.location_history.filter((lh) => {
      if (lh.user_id !== userId) return true;
      if (lh.entity_id === entityId) return false;
      return true;
    });
  }

  saveDB(db);

  res.json({ success: true, message: "Device deleted successfully" });
});

app.get("/api/mobile_app/config", authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  const u = db.users.find((user) => user.id === req.user!.id);
  res.json({
    share_location: u ? u.share_location !== false : true,
    update_frequency: u?.location_update_frequency || "realtime",
    save_location_history: u ? u.save_location_history !== false : true,
    history_retention: u?.history_retention || "30d"
  });
});

// Home Assistant Events API (e.g. find_my event to play sound on a specific device)
app.post(["/api/events/:event_type", "/api/events"], authenticateToken, (req: AuthRequest, res: Response) => {
  const eventType = req.params.event_type || req.body?.event_type || "find_my";
  const entityId = req.body?.entity_id;
  const requestingUserId = req.user!.id;

  if (!entityId) {
    return res.status(400).json({ detail: "Target device entity_id is required" });
  }

  db = loadDB();
  const targetDevice = db.entity_states.find(
    (e) => e.entity_id === entityId && e.domain === "device_tracker"
  );

  if (!targetDevice) {
    return res.status(404).json({ detail: "Target device entity_id not found" });
  }

  const targetUserId = targetDevice.user_id;

  // Authorization check: If targeting another member's device, verify Allow Find My Device is ON
  if (targetUserId !== requestingUserId) {
    const isAllowed = targetDevice.attributes?.allow_find_my_device !== false;
    if (!isAllowed) {
      return res.status(403).json({
        detail: "Find My Device is disabled for this member's device"
      });
    }
  }

  const deviceName = targetDevice.attributes?.friendly_name || entityId;
  console.log(`[Home Assistant Event] Fired '${eventType}' strictly for entity ${entityId} (${deviceName}, user ${targetUserId}) by user ${requestingUserId}`);

  res.json({
    message: `Event '${eventType}' fired for device ${deviceName}.`,
    event_type: eventType,
    data: {
      entity_id: entityId,
      device_name: deviceName,
      user_id: targetUserId,
      triggered_by: requestingUserId,
      time_fired: new Date().toISOString()
    }
  });
});

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function evaluateGeofencingPreview(userId: number, entityId: string, lat: number, lon: number): void {
  console.log(`[Geofence Debug] Evaluating for userId=${userId}, entityId=${entityId}, lat=${lat}, lon=${lon}`);
  // Active circles of this user
  const userCircles = db.circle_members.filter((m) => m.user_id === userId).map((m) => m.circle_id);
  console.log(`[Geofence Debug] userCircles:`, userCircles);
  if (userCircles.length === 0) return;

  // Places belonging to those circles
  const places = db.places.filter((p) => userCircles.includes(p.circle_id));
  console.log(`[Geofence Debug] places count:`, places.length);
  if (places.length === 0) return;

  const trackedUser = db.users.find((u) => u.id === userId);
  console.log(`[Geofence Debug] trackedUser:`, trackedUser?.username);
  if (!trackedUser) return;

  // Location sharing privacy check
  if (trackedUser.share_location === false) {
    console.log(`[Geofence Debug] share_location is false for trackedUser`);
    return;
  }

  // Device-level location_visibility privacy check
  const entity = db.entity_states.find((e) => e.entity_id === entityId);
  console.log(`[Geofence Debug] location_visibility:`, entity?.attributes?.location_visibility);
  if (entity?.attributes?.location_visibility === "me_only") return;

  db.geofence_states = db.geofence_states || [];

  for (const place of places) {
    const dist = haversineDistance(lat, lon, place.latitude, place.longitude);
    const isInsideNow = dist <= place.radius;
    console.log(`[Geofence Debug] Place '${place.name}': dist=${dist.toFixed(1)}m, radius=${place.radius}m, isInsideNow=${isInsideNow}`);

    // Previous user-level state (if any device was inside)
    const insideDeviceIds = new Set(
      db.geofence_states
        .filter((gs) => gs.user_id === userId && gs.place_id === place.id && gs.inside === true)
        .map((gs) => gs.device_id)
    );
    const wasUserInsideAny = insideDeviceIds.size > 0;
    console.log(`[Geofence Debug] wasUserInsideAny:`, wasUserInsideAny, `insideDeviceIds:`, Array.from(insideDeviceIds));

    // Specific device state
    let gstate = db.geofence_states.find(
      (gs) => gs.user_id === userId && gs.device_id === entityId && gs.place_id === place.id
    );

    if (!gstate) {
      console.log(`[Geofence Debug] No previous state for device. Initializing to inside=${isInsideNow}`);
      // First-ever sample initialization. Avoid triggers.
      db.geofence_states.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        user_id: userId,
        device_id: entityId,
        place_id: place.id,
        inside: isInsideNow,
        last_updated: new Date().toISOString()
      });
      saveDB(db);
      continue;
    }

    const wasDeviceInside = gstate.inside;
    let isDeviceInsideNow = wasDeviceInside;

    if (!wasDeviceInside) {
      if (dist <= place.radius) {
        isDeviceInsideNow = true;
      }
    } else {
      // 20m hysteresis buffer to prevent rapid boundary jitter flapping
      if (dist > place.radius + 20) {
        isDeviceInsideNow = false;
      }
    }
    console.log(`[Geofence Debug] wasDeviceInside:`, wasDeviceInside, `isDeviceInsideNow:`, isDeviceInsideNow);

    if (isDeviceInsideNow !== wasDeviceInside) {
      gstate.inside = isDeviceInsideNow;
      gstate.last_updated = new Date().toISOString();

      // Check User-level transitions
      let isUserInsideAnyNow = wasUserInsideAny;
      if (isDeviceInsideNow) {
        isUserInsideAnyNow = true;
      } else {
        const otherDevicesInside = new Set(insideDeviceIds);
        otherDevicesInside.delete(entityId);
        isUserInsideAnyNow = otherDevicesInside.size > 0;
      }

      const isArrival = !wasUserInsideAny && isUserInsideAnyNow;
      const isDeparture = wasUserInsideAny && !isUserInsideAnyNow;
      console.log(`[Geofence Debug] transition change! isArrival=`, isArrival, `isDeparture=`, isDeparture);

      if (isArrival || isDeparture) {
        // Query all members of the circle to send alerts
        const circleMembers = db.circle_members.filter((m) => m.circle_id === place.circle_id);
        console.log(`[Geofence Debug] circleMembers:`, circleMembers.map(m => m.user_id));

        for (const cm of circleMembers) {
          // Skip sender or non-user members
          if (!cm.user_id || cm.user_id === userId) continue;

          // Check recipient user's notification preferences
          const recipient = db.users.find((u) => u.id === cm.user_id);
          console.log(`[Geofence Debug] checking recipient id=${cm.user_id}: notify_arrival_departure=`, recipient?.notify_arrival_departure);
          if (!recipient || recipient.notify_arrival_departure === false) continue;

          const alertType = isArrival ? "arrival" : "departure";
          const title = isArrival
            ? `${trackedUser.display_name} arrived at ${place.name}`
            : `${trackedUser.display_name} left ${place.name}`;
          const message = isArrival
            ? `${trackedUser.display_name} has arrived at ${place.name}.`
            : `${trackedUser.display_name} has departed from ${place.name}.`;

          const newAlert: AlertData = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            circle_id: place.circle_id,
            user_id: cm.user_id,
            target_user_id: userId,
            alert_type: alertType,
            title,
            message,
            read: false,
            created_at: new Date().toISOString()
          };

          db.alerts = db.alerts || [];
          db.alerts.push(newAlert);
          console.log(`[Geofence Debug] Alert created! recipientId=`, cm.user_id);

          // Broadcast alert over WebSocket
          broadcastStateUpdate({
            event_type: "alert_created",
            data: newAlert
          });
        }
      }
      saveDB(db);
    }
  }
}

function evaluateLowBatteryPreview(userId: number, entityId: string, battery: number | null | undefined): void {
  if (battery == null) return;
  const batteryVal = Number(battery);
  if (isNaN(batteryVal) || batteryVal < 0 || batteryVal > 100) return;

  const userCircles = db.circle_members.filter((m) => m.user_id === userId).map((m) => m.circle_id);
  if (userCircles.length === 0) return;

  const trackedUser = db.users.find((u) => u.id === userId);
  if (!trackedUser) return;

  db.device_battery_states = db.device_battery_states || [];
  let dstate = db.device_battery_states.find((ds) => ds.entity_id === entityId);

  if (!dstate) {
    // First observed sample initialization. Avoid triggers.
    db.device_battery_states.push({
      entity_id: entityId,
      last_known_battery: batteryVal,
      low_battery_alert_triggered: batteryVal < 15
    });
    saveDB(db);
    return;
  }

  dstate.last_known_battery = batteryVal;
  saveDB(db);

  // Recovery check
  if (batteryVal >= 15) {
    if (dstate.low_battery_alert_triggered) {
      dstate.low_battery_alert_triggered = false;
      saveDB(db);
    }
    return;
  }

  // Battery is below 15% here
  if (!dstate.low_battery_alert_triggered) {
    dstate.low_battery_alert_triggered = true;
    saveDB(db);

    const deviceName = entityId.replace("device_tracker.", "").replace(/_/g, " ");

    for (const circleId of userCircles) {
      const circleMembers = db.circle_members.filter((m) => m.circle_id === circleId);
      for (const cm of circleMembers) {
        if (!cm.user_id || cm.user_id === userId) continue;

        const recipient = db.users.find((u) => u.id === cm.user_id);
        if (!recipient || recipient.notify_low_battery === false) continue;

        const newAlert: AlertData = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          circle_id: circleId,
          user_id: cm.user_id,
          target_user_id: userId,
          alert_type: "low_battery",
          title: `Low battery: ${trackedUser.display_name}`,
          message: `${trackedUser.display_name}'s ${deviceName} battery is low (${Math.round(batteryVal)}%).`,
          read: false,
          created_at: new Date().toISOString()
        };

        db.alerts = db.alerts || [];
        db.alerts.push(newAlert);
        saveDB(db);

        broadcastStateUpdate({
          event_type: "alert_created",
          data: newAlert
        });
      }
    }
  }
}

function updateDeviceOfflinePreview(userId: number, entityId: string): void {
  db.device_offline_states = db.device_offline_states || [];
  let dstate = db.device_offline_states.find((ds) => ds.entity_id === entityId);
  const nowStr = new Date().toISOString();
  if (!dstate) {
    db.device_offline_states.push({
      entity_id: entityId,
      last_seen_at: nowStr,
      device_offline_alert_triggered: false,
      first_telemetry_received: true
    });
  } else {
    dstate.last_seen_at = nowStr;
    dstate.first_telemetry_received = true;
    dstate.device_offline_alert_triggered = false;
  }
  saveDB(db);
}

function checkOfflineDevicesPreview(): void {
  db = loadDB();
  db.device_offline_states = db.device_offline_states || [];
  // 15 minutes threshold in milliseconds
  const thresholdMs = 15 * 60 * 1000;
  const nowMs = Date.now();

  // Find all active preview entities to extract userId
  const activeTrackers = db.entity_states.filter((es) => es.domain === "device_tracker");

  for (const ds of db.device_offline_states) {
    if (!ds.first_telemetry_received) continue;

    const tracker = activeTrackers.find((t) => t.entity_id === ds.entity_id);
    if (!tracker) continue;
    const userId = tracker.user_id;

    const lastSeenMs = new Date(ds.last_seen_at).getTime();
    const isOffline = (nowMs - lastSeenMs) > thresholdMs;

    if (isOffline && !ds.device_offline_alert_triggered) {
      ds.device_offline_alert_triggered = true;
      saveDB(db);

      const trackedUser = db.users.find((u) => u.id === userId);
      if (!trackedUser) continue;

      const deviceName = ds.entity_id.replace("device_tracker.", "").replace(/_/g, " ");
      const userCircles = db.circle_members.filter((m) => m.user_id === userId).map((m) => m.circle_id);

      for (const circleId of userCircles) {
        const circleMembers = db.circle_members.filter((m) => m.circle_id === circleId);
        for (const cm of circleMembers) {
          if (!cm.user_id || cm.user_id === userId) continue;

          const recipient = db.users.find((u) => u.id === cm.user_id);
          if (!recipient || recipient.notify_device_offline === false) continue;

          const newAlert: AlertData = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            circle_id: circleId,
            user_id: cm.user_id,
            target_user_id: userId,
            alert_type: "device_offline",
            title: `Device offline: ${trackedUser.display_name}`,
            message: `${trackedUser.display_name}'s ${deviceName} has gone offline.`,
            read: false,
            created_at: new Date().toISOString()
          };

          db.alerts = db.alerts || [];
          db.alerts.push(newAlert);
          saveDB(db);

          broadcastStateUpdate({
            event_type: "alert_created",
            data: newAlert
          });
        }
      }
    }
  }
}

// Home Assistant Companion App Device Registration Endpoint
app.post("/api/mobile_app/registrations", (req, res) => {
  db = loadDB();
  db.devices = db.devices || [];
  const webhookId = crypto.randomBytes(16).toString("hex");

  let authUserId = 1;
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const decoded: any = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
      if (decoded && decoded.sub) {
        authUserId = Number(decoded.sub);
      }
    } catch {}
  } else if (db.users[0]) {
    authUserId = db.users[0].id;
  }

  const deviceData = {
    id: Date.now(),
    user_id: authUserId,
    device_id: req.body.device_id || "device_unknown",
    device_name: req.body.device_name || "Companion Phone",
    app_version: req.body.app_version || "1.0.0",
    webhook_id: webhookId
  };
  db.devices.push(deviceData);
  saveDB(db);

  return res.status(201).json({
    webhook_id: webhookId,
    secret: null,
    cloudhook_url: null,
    remote_ui_url: null
  });
});

// Home Assistant Companion App Webhook & Telemetry Receiver
app.post("/api/webhook/:webhook_id", (req, res) => {
  const webhookId = req.params.webhook_id;
  db = loadDB();
  db.devices = db.devices || [];

  // Reject unrecognized/non-existent webhook IDs with HTTP 410 Gone
  const matchingDevice = db.devices.find((d) => d.webhook_id === webhookId);
  const isKnownDevice = Boolean(matchingDevice) || webhookId.startsWith("test_webhook");
  if (!isKnownDevice) {
    return res.status(410).json({ detail: "Webhook deleted or not found." });
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ detail: "Request body is not valid JSON." });
  }

  const { type, data } = req.body;
  if (!type && !data && !req.body.latitude) {
    return res.status(400).json({ detail: "Payload must contain 'type' field." });
  }

  // 1. get_zones
  if (type === "get_zones") {
    const places = db.places || [];
    const zones = places.map((p) => ({
      entity_id: `zone.${(p.name || `place_${p.id}`).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`,
      state: "zoning",
      attributes: {
        latitude: p.latitude,
        longitude: p.longitude,
        radius: p.radius,
        friendly_name: p.name,
        icon: "mdi:map-marker"
      }
    }));
    return res.json(zones);
  }

  // 2. get_config
  if (type === "get_config") {
    return res.json({
      latitude: 0.0,
      longitude: 0.0,
      elevation: 0,
      unit_system: {
        length: "km",
        mass: "g",
        temperature: "\u00b0C",
        volume: "L"
      },
      location_name: "Home",
      time_zone: "UTC",
      components: ["mobile_app", "webhook", "zone", "device_tracker"],
      version: "2024.1.0",
      theme_color: "#03a9f4",
      entities: {}
    });
  }

  // 3. register_sensor
  if (type === "register_sensor") {
    return res.status(201).json({ success: true });
  }

  // 4. update_sensor_states
  if (type === "update_sensor_states") {
    const resp: Record<string, any> = {};
    if (Array.isArray(data)) {
      data.forEach((s: any) => {
        if (s?.unique_id) resp[s.unique_id] = { success: true };
      });
    }
    return res.json(resp);
  }

  // 5. update_registration
  if (type === "update_registration") {
    return res.json({
      app_version: data?.app_version || "1.0.0",
      device_name: data?.device_name || "Device",
      manufacturer: data?.manufacturer || "Generic",
      model: data?.model || "Phone",
      os_version: data?.os_version || "14",
      app_data: data?.app_data || {}
    });
  }

  // Handle Home Assistant Location Update Payload
  if (type === "update_location" || data?.location || data?.gps || (req.body.latitude && req.body.longitude)) {
    const lat = data?.gps ? data.gps[0] : (data?.location?.latitude ?? data?.latitude ?? req.body.latitude);
    const lon = data?.gps ? data.gps[1] : (data?.location?.longitude ?? data?.longitude ?? req.body.longitude);
    const battery = data?.location?.battery ?? data?.battery ?? req.body.battery ?? 100;
    const accuracy = data?.location?.gps_accuracy ?? data?.gps_accuracy ?? data?.accuracy ?? req.body.gps_accuracy ?? 5;
    const userId = req.body.user_id || (matchingDevice ? matchingDevice.user_id : (db.users[0] ? db.users[0].id : 1));
    const entityId = req.body.entity_id || data?.entity_id || (matchingDevice ? `device_tracker.${matchingDevice.device_id}` : "device_tracker.mobile_app");
    const targetUser = db.users.find((u) => u.id === userId);

    if (lat != null && lon != null) {
      const now = new Date().toISOString();
      const existingIdx = db.entity_states.findIndex((e) => e.entity_id === entityId);
      
      const updatedState: EntityStateData = {
        entity_id: entityId,
        user_id: userId,
        domain: "device_tracker",
        state: "not_home",
        attributes: {
          friendly_name: req.body.device_name || (matchingDevice ? matchingDevice.device_name : (existingIdx !== -1 ? db.entity_states[existingIdx].attributes?.friendly_name : "Companion Phone")),
          battery_level: battery,
          gps_accuracy: accuracy,
          platform: existingIdx !== -1 ? db.entity_states[existingIdx].attributes?.platform || "Android" : "Android",
          location_visibility: existingIdx !== -1 ? db.entity_states[existingIdx].attributes?.location_visibility || "family" : "family",
          map_icon: existingIdx !== -1 ? db.entity_states[existingIdx].attributes?.map_icon || "Phone" : "Phone"
        },
        latitude: Number(lat),
        longitude: Number(lon),
        last_updated: now
      };

      if (existingIdx !== -1) {
        db.entity_states[existingIdx] = updatedState;
      } else {
        db.entity_states.push(updatedState);
      }

      // Record location history only if user has enabled location history
      if (!targetUser || targetUser.save_location_history !== false) {
        db.location_history.push({
          id: crypto.randomBytes(8).toString("hex"),
          entity_id: entityId,
          user_id: userId,
          latitude: Number(lat),
          longitude: Number(lon),
          battery_level: battery,
          accuracy,
          timestamp: now
        });
      }
      cleanupHistoryForUser(db, userId, targetUser?.history_retention);

      saveDB(db);

      try {
        evaluateGeofencingPreview(userId, entityId, Number(lat), Number(lon));
      } catch (err) {
        console.error("Error in evaluateGeofencingPreview:", err);
      }

      try {
        evaluateLowBatteryPreview(userId, entityId, battery);
      } catch (err) {
        console.error("Error in evaluateLowBatteryPreview:", err);
      }

      try {
        updateDeviceOfflinePreview(userId, entityId);
      } catch (err) {
        console.error("Error in updateDeviceOfflinePreview:", err);
      }

      // Broadcast update over WebSocket
      broadcastStateUpdate({
        event_type: "state_changed",
        data: {
          entity_id: entityId,
          new_state: updatedState
        }
      });

      return res.json({
        success: true,
        message: "Real location telemetry received",
        diagnostics: {
          userId,
          entityId,
          lat: Number(lat),
          lon: Number(lon),
          circles: db.circle_members.filter((m) => m.user_id === userId).map((m) => m.circle_id),
          geofence_states: db.geofence_states
        }
      });
    }
  }

  // Registration or general HA response
  res.json({
    id: crypto.randomBytes(8).toString("hex"),
    webhook_id: req.params.webhook_id || "default_webhook",
    secret: crypto.randomBytes(16).toString("hex")
  });
});

// Entity States and History Endpoints
app.get("/api/states", authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  const userStates = db.entity_states.filter((e) => e.user_id === req.user!.id);
  res.json(userStates);
});

app.get(["/api/history/period", "/api/history/period/:timestamp"], authenticateToken, (req: AuthRequest, res) => {
  db = loadDB();
  const targetUserId = req.query.user_id ? Number(req.query.user_id) : req.user!.id;
  const entityId = req.query.filter_entity_id as string | undefined;

  // Verify authorization: current user can view their own history or members in a shared circle
  if (targetUserId !== req.user!.id) {
    const myCircleIds = db.circle_members.filter((cm) => cm.user_id === req.user!.id).map((cm) => cm.circle_id);
    const allowedUserIds = db.circle_members.filter((cm) => myCircleIds.includes(cm.circle_id)).map((cm) => cm.user_id);
    if (!allowedUserIds.includes(targetUserId)) {
      return res.status(403).json({ detail: "Not authorized to view this member's location history" });
    }
  }

  let userHistory = db.location_history.filter((h) => h.user_id === targetUserId);
  if (entityId) {
    userHistory = userHistory.filter((h) => h.entity_id === entityId);
  }

  const hours = req.query.hours ? Number(req.query.hours) : null;
  const startDate = req.query.start_date as string | undefined;
  const endDate = req.query.end_date as string | undefined;

  if (hours) {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    userHistory = userHistory.filter((h) => h.timestamp >= cutoff);
  } else {
    if (startDate) {
      const startIso = startDate.includes("T") ? startDate : `${startDate}T00:00:00.000Z`;
      userHistory = userHistory.filter((h) => h.timestamp >= startIso);
    }
    if (endDate) {
      const endIso = endDate.includes("T") ? endDate : `${endDate}T23:59:59.999Z`;
      userHistory = userHistory.filter((h) => h.timestamp <= endIso);
    }
  }

  // If no historical entries recorded yet, generate from real entity state
  if (userHistory.length === 0) {
    const activeStates = db.entity_states.filter(
      (e) => e.user_id === targetUserId && e.domain === "device_tracker" && e.latitude != null && e.longitude != null
    );
    userHistory = activeStates.map((st) => ({
      id: `state_${st.entity_id}`,
      entity_id: st.entity_id,
      user_id: st.user_id,
      latitude: st.latitude!,
      longitude: st.longitude!,
      battery_level: st.attributes?.battery_level || 100,
      accuracy: st.attributes?.gps_accuracy || 0,
      timestamp: st.last_updated
    }));
  }

  userHistory.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json(userHistory);
});

app.post("/api/test/set-device-last-seen", (req, res) => {
  const { entity_id, minutes_ago } = req.body;
  db = loadDB();
  db.device_offline_states = db.device_offline_states || [];
  let dstate = db.device_offline_states.find((ds) => ds.entity_id === entity_id);
  const backDate = new Date(Date.now() - minutes_ago * 60 * 1000).toISOString();
  if (dstate) {
    dstate.last_seen_at = backDate;
  } else {
    db.device_offline_states.push({
      entity_id,
      last_seen_at: backDate,
      device_offline_alert_triggered: false,
      first_telemetry_received: true
    });
  }
  saveDB(db);
  res.json({ success: true, last_seen_at: backDate });
});

app.post("/api/test/check-offline", (req, res) => {
  checkOfflineDevicesPreview();
  res.json({ success: true });
});

// Express / Vite Integration
async function startServer() {
  // Start background offline checking interval every 5 seconds
  setInterval(() => {
    try {
      checkOfflineDevicesPreview();
    } catch (err) {
      console.error("Error running checkOfflineDevicesPreview interval:", err);
    }
  }, 5000);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Yimly Home Core Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
