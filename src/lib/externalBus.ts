// Helpers to dispatch messages to Android Companion App (V2 and V1) and iOS External Bus
import { logWsDiag } from "./haWebSocket";

export interface ExternalAppConfig {
  hasSettingsScreen?: boolean;
  canClose?: boolean;
  hasSidebar?: boolean;
  [key: string]: any;
}

let externalAppConfig: ExternalAppConfig | null = null;
let configRequestId = 100;

export const getExternalConfig = (): ExternalAppConfig | null => externalAppConfig;

export const setExternalConfig = (config: Partial<ExternalAppConfig> | null) => {
  if (config === null) {
    externalAppConfig = null;
  } else {
    externalAppConfig = { ...(externalAppConfig || {}), ...config };
  }
};

export const isCompanionApp = (): boolean => {
  if (typeof window === "undefined") return false;
  const hasSessionAuth = typeof sessionStorage !== "undefined" && sessionStorage?.getItem?.("external_auth") === "1";
  const hasLocalAuth = typeof localStorage !== "undefined" && localStorage?.getItem?.("external_auth") === "1";
  return Boolean(
    (window as any).externalAppV2 ||
    (window as any).externalApp ||
    (window as any).webkit?.messageHandlers?.externalBus ||
    (window as any).webkit?.messageHandlers?.getExternalAuth ||
    hasSessionAuth ||
    hasLocalAuth
  );
};

export const hasNativeSettingsScreen = (): boolean => {
  if (!isCompanionApp()) return false;
  return Boolean(externalAppConfig?.hasSettingsScreen);
};

export const notifyExternalBus = (type: string, payload?: any, id?: number) => {
  if (typeof window === "undefined") return;

  logWsDiag("EXTERNAL_BUS_NOTIFY_DISPATCH", {
    type,
    hasPayload: payload !== undefined,
    id: id !== undefined ? id : undefined
  });

  // Construct protocol-compliant Home Assistant External Bus message envelope
  const msgObj: Record<string, any> = {};

  if (id !== undefined && id !== null) {
    msgObj.id = id;
  }

  if (payload && typeof payload === "object" && ("result" in payload || "success" in payload)) {
    // Envelope for query responses (e.g., config/get response)
    msgObj.type = type === "config/get" ? "result" : type;
    msgObj.success = payload.success !== undefined ? Boolean(payload.success) : true;
    if (payload.result !== undefined) {
      msgObj.result = payload.result;
    } else if (payload.payload !== undefined) {
      msgObj.result = payload.payload;
    } else {
      msgObj.result = payload;
    }
  } else if (payload !== undefined) {
    msgObj.type = type;
    msgObj.payload = payload;
  } else {
    msgObj.type = type;
  }

  const msgStr = JSON.stringify(msgObj);

  // 1. Android Companion App V2 (WebMessageListener) - expects JSON String
  try {
    const extAppV2 = (window as any).externalAppV2;
    if (extAppV2 && typeof extAppV2.postMessage === "function") {
      extAppV2.postMessage(msgStr);
    }
  } catch (err) {
    console.warn("[ExternalBus] externalAppV2 postMessage error:", err);
  }

  // 2. Android Companion App V1 (JavascriptInterface) - expects JSON String
  try {
    const extApp = (window as any).externalApp;
    if (extApp && typeof extApp.externalBus === "function") {
      extApp.externalBus(msgStr);
    } else if (extApp && typeof extApp.postMessage === "function") {
      extApp.postMessage(msgStr);
    }
  } catch (err) {
    console.warn("[ExternalBus] externalApp notify error:", err);
  }

  // 3. iOS Companion App WebKit messageHandler - requires native JS Object dictionary
  // so WKWebView bridges it directly into a Swift [String: Any] dictionary required by Alamofire/ObjectMapper
  try {
    const webkit = (window as any).webkit;
    if (webkit?.messageHandlers?.externalBus?.postMessage) {
      try {
        webkit.messageHandlers.externalBus.postMessage(msgObj);
      } catch (e) {
        webkit.messageHandlers.externalBus.postMessage(msgStr);
      }
    }
  } catch (err) {
    console.warn("[ExternalBus] webkit externalBus postMessage error:", err);
  }
};

export const requestExternalConfig = (timeoutMs: number = 2500): Promise<ExternalAppConfig | null> => {
  if (typeof window === "undefined" || !isCompanionApp()) {
    return Promise.resolve(null);
  }

  const id = ++configRequestId;
  logWsDiag("EXTERNAL_BUS_CONFIG_GET_REQUEST", { id });

  notifyExternalBus("config/get", undefined, id);

  return new Promise<ExternalAppConfig | null>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(externalAppConfig);
      }
    }, timeoutMs);

    const checkInterval = setInterval(() => {
      if (externalAppConfig?.hasSettingsScreen !== undefined) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(checkInterval);
          resolve(externalAppConfig);
        }
      }
    }, 50);
  });
};

export const showNativeSettings = (): boolean => {
  if (!isCompanionApp() || !hasNativeSettingsScreen()) {
    return false;
  }
  logWsDiag("EXTERNAL_BUS_SHOW_SETTINGS");
  notifyExternalBus("config_screen/show");
  return true;
};

export const handleIncomingExternalBusMessage = (msgStr: string | any) => {
  try {
    const msg = typeof msgStr === "string" ? JSON.parse(msgStr) : msgStr;
    logWsDiag("EXTERNAL_BUS_INCOMING_MSG", { msgType: msg?.type, id: msg?.id });
    console.log("[ExternalBus] Incoming message from native app:", msg);

    if (msg?.type === "result" && msg?.result && typeof msg.result === "object") {
      externalAppConfig = {
        ...(externalAppConfig || {}),
        ...msg.result
      };
      logWsDiag("EXTERNAL_BUS_CONFIG_UPDATED", externalAppConfig || undefined);
    } else if (msg?.result && typeof msg.result === "object") {
      externalAppConfig = {
        ...(externalAppConfig || {}),
        ...msg.result
      };
      logWsDiag("EXTERNAL_BUS_CONFIG_UPDATED", externalAppConfig || undefined);
    } else if (msg?.type === "config" && msg?.payload) {
      externalAppConfig = {
        ...(externalAppConfig || {}),
        ...msg.payload
      };
      logWsDiag("EXTERNAL_BUS_CONFIG_UPDATED", externalAppConfig || undefined);
    }

    if (msg?.type === "config/get") {
      notifyExternalBus("config/get", {
        success: true,
        result: {
          ha_version: "2026.9.1",
          location_name: "Yim-Kin"
        }
      }, msg?.id);
    }
  } catch (err) {
    console.warn("[ExternalBus] Error handling incoming external bus message:", err);
  }
};

// Helper to notify native app when revoking external auth
export const revokeExternalAuth = () => {
  if (typeof window === "undefined") return;

  logWsDiag("EXTERNAL_AUTH_REVOKE_REQUEST");

  try {
    (window as any).externalAuthRevokeToken = (success: boolean) => {
      logWsDiag("EXTERNAL_AUTH_REVOKE_CALLBACK", { success });
      console.log("[ExternalAuth] Token revoked on native app:", success);
    };

    const extAppV2 = (window as any).externalAppV2;
    if (extAppV2 && typeof extAppV2.postMessage === "function") {
      extAppV2.postMessage(
        JSON.stringify({
          type: "revokeExternalAuth",
          payload: { callback: "externalAuthRevokeToken" }
        })
      );
    }

    const extApp = (window as any).externalApp;
    if (extApp && typeof extApp.revokeExternalAuth === "function") {
      try {
        extApp.revokeExternalAuth(JSON.stringify({ callback: "externalAuthRevokeToken" }));
      } catch {
        extApp.revokeExternalAuth({ callback: "externalAuthRevokeToken" });
      }
    }
  } catch (e) {
    console.warn("[ExternalAuth] Error revoking external auth:", e);
  }
};

// Helper to request External Auth token from official Home Assistant Companion App
export const requestExternalAuthToken = (): Promise<string | null> => {
  if (typeof window === "undefined") return Promise.resolve(null);

  logWsDiag("EXTERNAL_AUTH_TOKEN_REQUEST_START");

  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pollTimer: any = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        logWsDiag("EXTERNAL_AUTH_TOKEN_TIMEOUT");
        console.warn("[ExternalAuth] Timeout waiting for native externalApp response.");
        resolve(null);
      }
    }, 4500);

    // Official Home Assistant callback name expected and validated by Android Companion App
    (window as any).externalAuthSetToken = (success: boolean, data?: { access_token?: string; expires_in?: number }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();

      logWsDiag("EXTERNAL_AUTH_TOKEN_RESPONSE", {
        success,
        hasAccessToken: Boolean(data?.access_token),
        tokenLength: data?.access_token?.length || 0,
        expiresIn: data?.expires_in
      });

      if (success && data?.access_token) {
        console.log("[ExternalAuth] Token received from Companion App externalApp bridge.");
        resolve(data.access_token);
      } else {
        console.warn("[ExternalAuth] externalApp returned failure or no access_token:", data);
        resolve(null);
      }
    };

    const attemptSendRequest = (): boolean => {
      // 1. Android V2 (WebMessageListener) - postMessage with getExternalAuth payload
      const extAppV2 = (window as any).externalAppV2;
      if (extAppV2 && typeof extAppV2.postMessage === "function") {
        try {
          console.log("[ExternalAuth] Requesting token via window.externalAppV2.postMessage");
          extAppV2.postMessage(
            JSON.stringify({
              type: "getExternalAuth",
              payload: {
                callback: "externalAuthSetToken",
                force: false
              }
            })
          );
          return true;
        } catch (e) {
          console.warn("[ExternalAuth] Error calling externalAppV2.postMessage:", e);
        }
      }

      // 2. Android V1 / JavascriptInterface - getExternalAuth method
      const extApp = (window as any).externalApp;
      if (extApp) {
        if (typeof extApp.getExternalAuth === "function") {
          try {
            console.log("[ExternalAuth] Requesting token via window.externalApp.getExternalAuth");
            try {
              extApp.getExternalAuth(
                JSON.stringify({
                  callback: "externalAuthSetToken",
                  force: false
                })
              );
            } catch {
              extApp.getExternalAuth({
                callback: "externalAuthSetToken",
                force: false
              });
            }
            return true;
          } catch (e) {
            console.warn("[ExternalAuth] Error calling externalApp.getExternalAuth:", e);
          }
        } else if (typeof extApp.postMessage === "function") {
          try {
            extApp.postMessage(
              JSON.stringify({
                type: "getExternalAuth",
                payload: {
                  callback: "externalAuthSetToken",
                  force: false
                }
              })
            );
            return true;
          } catch (e) {
            console.warn("[ExternalAuth] Error calling extApp.postMessage:", e);
          }
        }
      }

      // 3. iOS WebKit message handlers
      const webkit = (window as any).webkit;
      if (webkit?.messageHandlers?.getExternalAuth?.postMessage) {
        try {
          console.log("[ExternalAuth] Requesting token via webkit.messageHandlers.getExternalAuth");
          webkit.messageHandlers.getExternalAuth.postMessage({
            callback: "externalAuthSetToken",
            force: false
          });
          return true;
        } catch (e) {
          console.warn("[ExternalAuth] Error calling webkit messageHandler:", e);
        }
      }

      return false;
    };

    // Try immediately
    if (attemptSendRequest()) {
      return;
    }

    // If not immediately available (e.g. injected shortly after DOM eval), poll briefly
    let pollCount = 0;
    pollTimer = setInterval(() => {
      pollCount++;
      if (resolved) {
        cleanup();
        return;
      }
      if (attemptSendRequest() || pollCount > 30) {
        cleanup();
      }
    }, 80);
  });
};
