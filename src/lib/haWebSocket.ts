import { notifyExternalBus } from "./externalBus";

export interface WebSocketSubscriber {
  id: string;
  onStateChanged?: () => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export interface HAWebSocketManagerOptions {
  wsUrl?: string;
  webSocketClass?: any;
  reconnectIntervalMs?: number;
  unmountDebounceMs?: number;
}

export type ManagerState = "IDLE" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";

// Helper to format readyState numbers into descriptive names
export function getReadyStateName(state?: number): string {
  switch (state) {
    case 0: return "0(CONNECTING)";
    case 1: return "1(OPEN)";
    case 2: return "2(CLOSING)";
    case 3: return "3(CLOSED)";
    default: return `${state}(UNKNOWN)`;
  }
}

// Structured [WS-DIAG] logger with ISO timestamp and key=value formatting
export function logWsDiag(event: string, details?: Record<string, any>) {
  const ts = new Date().toISOString();
  if (details && Object.keys(details).length > 0) {
    const formatted = Object.entries(details)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    console.log(`[WS-DIAG] ${ts} ${event} ${formatted}`);
  } else {
    console.log(`[WS-DIAG] ${ts} ${event}`);
  }
}

export class HAWebSocketManager {
  private activeSocket: WebSocket | null = null;
  private currentGeneration: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isManuallyClosed: boolean = false;
  private currentToken: string | null = null;
  private subscribers: Map<string, WebSocketSubscriber> = new Map();
  private isConnected: boolean = false;
  private managerState: ManagerState = "IDLE";

  // Configurable options for testing and environment adaptation
  private customWsUrl: string | null = null;
  private customWebSocketClass: any = null;
  private reconnectIntervalMs: number = 4000;
  private unmountDebounceMs: number = 100;

  constructor(options?: HAWebSocketManagerOptions) {
    if (options?.wsUrl) this.customWsUrl = options.wsUrl;
    if (options?.webSocketClass) this.customWebSocketClass = options.webSocketClass;
    if (options?.reconnectIntervalMs) this.reconnectIntervalMs = options.reconnectIntervalMs;
    if (options?.unmountDebounceMs !== undefined) this.unmountDebounceMs = options.unmountDebounceMs;
  }

  public setOptions(options: HAWebSocketManagerOptions) {
    if (options.wsUrl !== undefined) this.customWsUrl = options.wsUrl;
    if (options.webSocketClass !== undefined) this.customWebSocketClass = options.webSocketClass;
    if (options.reconnectIntervalMs !== undefined) this.reconnectIntervalMs = options.reconnectIntervalMs;
    if (options.unmountDebounceMs !== undefined) this.unmountDebounceMs = options.unmountDebounceMs;
  }

  private transitionState(nextState: ManagerState, reason: string): void {
    if (this.managerState === nextState) return;
    const fromState = this.managerState;
    this.managerState = nextState;
    logWsDiag("STATE_TRANSITION", {
      from: fromState,
      to: nextState,
      reason,
      gen: this.currentGeneration,
      subscribers: this.subscribers.size
    });
  }

  private getWebSocketUrl(): string {
    if (this.customWsUrl) return this.customWsUrl;
    if (typeof window !== "undefined") {
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProtocol}//${window.location.host}/api/websocket`;
    }
    return "ws://127.0.0.1:3000/api/websocket";
  }

  private getWebSocketClass(): any {
    if (this.customWebSocketClass) return this.customWebSocketClass;
    if (typeof WebSocket !== "undefined") return WebSocket;
    if (typeof globalThis !== "undefined" && (globalThis as any).WebSocket) return (globalThis as any).WebSocket;
    throw new Error("No WebSocket implementation found in current environment");
  }

  /**
   * Connects to Home Assistant WebSocket backend.
   * Guarantees that concurrent/racing calls resolve to the EXACT SAME physical WebSocket.
   */
  public connect(token: string): WebSocket {
    if (!token) {
      throw new Error("Cannot connect WebSocket: access token is required");
    }

    this.isManuallyClosed = false;

    // 1. Cancel any pending reconnect timer so it can never race with this connection
    if (this.reconnectTimer) {
      logWsDiag("RECONNECT_TIMER_CANCELLED", {
        whyCancelled: "new_connect_call",
        gen: this.currentGeneration
      });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 2. Cancel any pending unmount debounce disconnect (e.g. from React StrictMode remount)
    if (this.pendingDisconnectTimer) {
      logWsDiag("PENDING_DISCONNECT_CANCELLED", {
        reason: "resubscribed_or_reconnected",
        gen: this.currentGeneration
      });
      clearTimeout(this.pendingDisconnectTimer);
      this.pendingDisconnectTimer = null;
    }

    // 3. Concurrency check: If an active socket is currently CONNECTING or OPEN with the SAME token,
    // reuse the existing physical socket. DO NOT create duplicate sockets.
    const WSClass = this.getWebSocketClass();
    const CONNECTING = WSClass.CONNECTING !== undefined ? WSClass.CONNECTING : 0;
    const OPEN = WSClass.OPEN !== undefined ? WSClass.OPEN : 1;

    if (
      this.activeSocket &&
      (this.activeSocket.readyState === CONNECTING || this.activeSocket.readyState === OPEN) &&
      this.currentToken === token
    ) {
      logWsDiag("REUSING_ACTIVE_SOCKET", {
        socketId: (this.activeSocket as any)._diagId || `sock_${this.currentGeneration}`,
        gen: this.currentGeneration,
        readyState: getReadyStateName(this.activeSocket.readyState),
        subscribers: this.subscribers.size
      });
      return this.activeSocket;
    }

    // 4. If an active socket exists with a different token or in closing state, cleanly discard it
    if (this.activeSocket) {
      const oldGen = this.currentGeneration;
      const oldSocketId = (this.activeSocket as any)._diagId || `sock_${oldGen}`;
      const oldReadyState = getReadyStateName(this.activeSocket.readyState);
      const isTokenChange = this.currentToken !== token;

      logWsDiag("CLOSING_OLDER_FOR_NEWER", {
        oldSocketId,
        oldGen,
        oldReadyState,
        reason: isTokenChange ? "token_changed" : "unhealthy_or_closed_previous_socket"
      });

      this.teardownSocket(
        this.activeSocket,
        false,
        isTokenChange ? "token_changed_replaced_by_newer" : "unhealthy_socket_replaced"
      );
    }

    this.currentToken = token;
    const myGeneration = ++this.currentGeneration;
    const socketId = `sock_${myGeneration}_${Date.now()}`;
    const url = this.getWebSocketUrl();

    this.transitionState("CONNECTING", "initiating_new_physical_socket");

    logWsDiag("PHYSICAL_SOCKET_CREATED", {
      socketId,
      gen: myGeneration,
      url,
      subscribers: this.subscribers.size
    });

    let ws: WebSocket;
    try {
      ws = new WSClass(url);
      (ws as any)._diagId = socketId;
      (ws as any)._diagGen = myGeneration;
    } catch (err: any) {
      logWsDiag("PHYSICAL_SOCKET_CREATE_FAILED", {
        socketId,
        gen: myGeneration,
        error: err?.message || String(err)
      });
      console.error("[HA WebSocket] Failed to instantiate WebSocket:", err);
      this.scheduleReconnect("socket_creation_failed");
      throw err;
    }

    this.activeSocket = ws;

    ws.onopen = () => {
      // Guard against stale socket
      if (this.currentGeneration !== myGeneration || this.activeSocket !== ws) {
        logWsDiag("STALE_EVENT_REJECTED", {
          eventType: "onopen",
          socketId,
          staleGen: myGeneration,
          currentGen: this.currentGeneration
        });
        return;
      }

      logWsDiag("SOCKET_OPEN", {
        socketId,
        gen: myGeneration,
        readyState: getReadyStateName(ws.readyState)
      });
      console.log("[HA WebSocket] Connected to /api/websocket");
    };

    ws.onmessage = (event: MessageEvent) => {
      // Guard against stale socket: never process or send messages on obsolete sockets
      if (this.currentGeneration !== myGeneration || this.activeSocket !== ws) {
        logWsDiag("STALE_EVENT_REJECTED", {
          eventType: "onmessage",
          socketId,
          staleGen: myGeneration,
          currentGen: this.currentGeneration
        });
        return;
      }

      try {
        const raw = typeof event.data === "string" ? event.data : event.data?.toString?.();
        const data = JSON.parse(raw);

        logWsDiag("MESSAGE_RECEIVED", {
          socketId,
          gen: myGeneration,
          msgType: data.type,
          id: data.id !== undefined ? data.id : undefined,
          eventType: data.type === "event" ? data.event?.event_type : undefined
        });

        if (data.type === "auth_required") {
          // Handshake challenge: send auth token (never log token itself)
          logWsDiag("AUTH_SEND", {
            socketId,
            gen: myGeneration,
            hasToken: Boolean(token),
            tokenLength: token.length
          });
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (data.type === "auth_ok") {
          logWsDiag("AUTH_OK_RECEIVED", {
            socketId,
            gen: myGeneration,
            ha_version: data.ha_version
          });
          console.log("[HA WebSocket] Auth successful (auth_ok). Notifying Companion App.");
          this.isConnected = true;
          this.transitionState("CONNECTED", "auth_ok_received");

          // Notify native companion app bridge
          logWsDiag("EXTERNAL_BUS_OUT_CONNECTED", { socketId, gen: myGeneration });
          notifyExternalBus("connection-status", { event: "connected" });

          // Subscribe to state changes and load initial state
          logWsDiag("INITIAL_SUBSCRIPTIONS_SEND", { socketId, gen: myGeneration });
          ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
          ws.send(JSON.stringify({ id: 2, type: "get_states" }));
          ws.send(JSON.stringify({ id: 3, type: "get_config" }));

          for (const sub of this.subscribers.values()) {
            try {
              sub.onConnected?.();
            } catch (e) {
              console.warn("[HA WebSocket] Subscriber onConnected error:", e);
            }
          }
        } else if (data.type === "auth_invalid") {
          logWsDiag("AUTH_INVALID_RECEIVED", {
            socketId,
            gen: myGeneration,
            message: data.message
          });
          console.warn("[HA WebSocket] Auth invalid.");
          notifyExternalBus("connection-status", { event: "auth-invalid" });
        } else if (data.type === "event" && data.event?.event_type === "state_changed") {
          for (const sub of this.subscribers.values()) {
            try {
              sub.onStateChanged?.();
            } catch (e) {
              console.warn("[HA WebSocket] Subscriber onStateChanged error:", e);
            }
          }
        }
      } catch (err: any) {
        logWsDiag("MESSAGE_PARSE_ERROR", {
          socketId,
          gen: myGeneration,
          error: err?.message || String(err)
        });
        console.warn("[HA WebSocket] Error parsing message:", err);
      }
    };

    ws.onclose = (event?: any) => {
      const code = event?.code;
      const reason = event?.reason || "";
      const wasClean = event?.wasClean;

      // Stale socket guard: a stale socket must NEVER replace or clear activeSocket,
      // notify external bus, or schedule reconnect!
      if (this.currentGeneration !== myGeneration || this.activeSocket !== ws) {
        logWsDiag("STALE_EVENT_REJECTED", {
          eventType: "onclose",
          socketId,
          staleGen: myGeneration,
          currentGen: this.currentGeneration,
          code,
          reason: reason || "(none)",
          wasClean,
          readyState: getReadyStateName(ws.readyState)
        });
        return;
      }

      logWsDiag("SOCKET_CLOSE", {
        socketId,
        gen: myGeneration,
        code,
        reason: reason || "(none)",
        wasClean,
        readyState: getReadyStateName(ws.readyState),
        isStale: false,
        wasManualClose: this.isManuallyClosed,
        closedDueToIntentionalShutdown: this.isManuallyClosed
      });

      console.log(`[HA WebSocket] Connection closed (code=${code}, reason=${reason || "none"}).`);
      this.isConnected = false;
      this.activeSocket = null;
      this.transitionState("DISCONNECTED", `socket_closed_code_${code}`);

      notifyExternalBus("connection-status", { event: "disconnected" });

      for (const sub of this.subscribers.values()) {
        try {
          sub.onDisconnected?.();
        } catch (e) {
          console.warn("[HA WebSocket] Subscriber onDisconnected error:", e);
        }
      }

      // Schedule reconnect ONLY if not manually closed and token is still active
      if (!this.isManuallyClosed && this.currentToken) {
        this.scheduleReconnect(`onclose_code_${code}`);
      } else {
        logWsDiag("RECONNECT_SKIPPED_ON_CLOSE", {
          socketId,
          gen: myGeneration,
          isManuallyClosed: this.isManuallyClosed,
          hasToken: Boolean(this.currentToken)
        });
      }
    };

    ws.onerror = (err: any) => {
      // Stale socket guard
      if (this.currentGeneration !== myGeneration || this.activeSocket !== ws) {
        logWsDiag("STALE_EVENT_REJECTED", {
          eventType: "onerror",
          socketId,
          staleGen: myGeneration,
          currentGen: this.currentGeneration
        });
        return;
      }

      logWsDiag("SOCKET_ERROR", {
        socketId,
        gen: myGeneration,
        readyState: getReadyStateName(ws.readyState),
        errorType: err?.type || typeof err,
        message: err?.message || (err?.error?.message ?? "")
      });
      console.warn("[HA WebSocket] Connection error:", err);
      try {
        logWsDiag("EXPLICIT_SOCKET_CLOSE", {
          socketId,
          gen: myGeneration,
          callerReason: "onerror_close_attempt",
          socketReadyState: getReadyStateName(ws.readyState),
          isIntentional: false
        });
        ws.close();
      } catch {}
    };

    return ws;
  }

  /**
   * Schedules a single reconnect attempt, ensuring no duplicates or racing timers.
   */
  private scheduleReconnect(why: string): void {
    if (this.isManuallyClosed || !this.currentToken) {
      logWsDiag("RECONNECT_NOT_SCHEDULED", {
        why,
        isManuallyClosed: this.isManuallyClosed,
        hasToken: Boolean(this.currentToken)
      });
      return;
    }

    // Clear any existing reconnect timer to guarantee only one timer is pending
    if (this.reconnectTimer) {
      logWsDiag("RECONNECT_TIMER_CANCELLED", {
        whyCancelled: "replacing_with_new_schedule",
        previousScheduleReason: why
      });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const WSClass = this.getWebSocketClass();
    const CONNECTING = WSClass.CONNECTING !== undefined ? WSClass.CONNECTING : 0;
    const OPEN = WSClass.OPEN !== undefined ? WSClass.OPEN : 1;

    // If a connection is already connecting or active, do NOT schedule reconnect
    if (
      this.activeSocket &&
      (this.activeSocket.readyState === CONNECTING || this.activeSocket.readyState === OPEN)
    ) {
      logWsDiag("RECONNECT_SUPPRESSED_SOCKET_ALREADY_ACTIVE", {
        socketId: (this.activeSocket as any)._diagId,
        gen: this.currentGeneration,
        readyState: getReadyStateName(this.activeSocket.readyState)
      });
      return;
    }

    logWsDiag("RECONNECT_TIMER_SCHEDULED", {
      delayMs: this.reconnectIntervalMs,
      why,
      gen: this.currentGeneration
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logWsDiag("RECONNECT_TIMER_FIRED", {
        why,
        gen: this.currentGeneration,
        isManuallyClosed: this.isManuallyClosed,
        hasToken: Boolean(this.currentToken)
      });

      if (this.isManuallyClosed || !this.currentToken) return;

      if (
        this.activeSocket &&
        (this.activeSocket.readyState === CONNECTING || this.activeSocket.readyState === OPEN)
      ) {
        logWsDiag("RECONNECT_TIMER_ABORTED_SOCKET_ALREADY_ACTIVE", {
          socketId: (this.activeSocket as any)._diagId,
          readyState: getReadyStateName(this.activeSocket.readyState)
        });
        return;
      }

      console.log("[HA WebSocket] Reconnecting...");
      try {
        this.connect(this.currentToken);
      } catch (err: any) {
        logWsDiag("RECONNECT_ATTEMPT_ERROR", {
          error: err?.message || String(err)
        });
        console.error("[HA WebSocket] Reconnect connection attempt failed:", err);
        this.scheduleReconnect("reconnect_attempt_failed");
      }
    }, this.reconnectIntervalMs);
  }

  /**
   * Gracefully tears down a socket, detaching all listeners so late events cannot fire.
   */
  private teardownSocket(
    socket: WebSocket,
    notifyDisconnect: boolean = false,
    callerReason: string = "teardown_socket"
  ): void {
    const socketId = (socket as any)._diagId || `sock_${this.currentGeneration}`;
    const targetGen = (socket as any)._diagGen || this.currentGeneration;
    const readyStateBefore = getReadyStateName(socket.readyState);

    // Invalidate generation
    this.currentGeneration++;

    logWsDiag("EXPLICIT_SOCKET_CLOSE", {
      socketId,
      targetGen,
      callerReason,
      socketReadyState: readyStateBefore,
      isIntentional: this.isManuallyClosed
    });

    // Detach all listeners immediately
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    } catch {}

    try {
      const WSClass = this.getWebSocketClass();
      const CLOSED = WSClass.CLOSED !== undefined ? WSClass.CLOSED : 3;
      if (socket.readyState !== CLOSED) {
        socket.close();
      }
    } catch {}

    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.isConnected = false;
    }

    if (notifyDisconnect) {
      logWsDiag("EXTERNAL_BUS_OUT_DISCONNECTED", { socketId, targetGen, callerReason });
      notifyExternalBus("connection-status", { event: "disconnected" });
    }
  }

  /**
   * Disconnects the active WebSocket session.
   * If isManualLogout is true, marks session as manually closed and clears credentials.
   */
  public disconnect(isManualLogout: boolean = true, callerReason: string = "disconnect_called"): void {
    logWsDiag("DISCONNECT_REQUEST", {
      isManualLogout,
      callerReason,
      hasActiveSocket: Boolean(this.activeSocket),
      activeSocketId: this.activeSocket ? (this.activeSocket as any)._diagId : null,
      gen: this.currentGeneration
    });

    if (isManualLogout) {
      this.isManuallyClosed = true;
      this.currentToken = null;
      this.transitionState("LOGGED_OUT", callerReason);
    } else {
      this.transitionState("DISCONNECTED", callerReason);
    }

    if (this.reconnectTimer) {
      logWsDiag("RECONNECT_TIMER_CANCELLED", {
        whyCancelled: `disconnect_${callerReason}`,
        gen: this.currentGeneration
      });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pendingDisconnectTimer) {
      logWsDiag("PENDING_DISCONNECT_CANCELLED", {
        whyCancelled: `disconnect_${callerReason}`,
        gen: this.currentGeneration
      });
      clearTimeout(this.pendingDisconnectTimer);
      this.pendingDisconnectTimer = null;
    }

    if (this.activeSocket) {
      this.teardownSocket(
        this.activeSocket,
        isManualLogout,
        isManualLogout ? `manual_logout_${callerReason}` : `unmount_${callerReason}`
      );
    }
  }

  /**
   * Subscribes a listener component.
   * Handles React StrictMode mount -> cleanup -> remount smoothly via debounce.
   */
  public subscribe(subscriber: WebSocketSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber);

    logWsDiag("SUBSCRIBER_ATTACHED", {
      subId: subscriber.id,
      totalSubscribers: this.subscribers.size,
      hasPendingDisconnectTimer: Boolean(this.pendingDisconnectTimer)
    });

    // Cancel pending disconnect if a new subscriber attaches
    if (this.pendingDisconnectTimer) {
      logWsDiag("PENDING_DISCONNECT_CANCELLED", {
        whyCancelled: `subscriber_attached_${subscriber.id}`,
        gen: this.currentGeneration
      });
      clearTimeout(this.pendingDisconnectTimer);
      this.pendingDisconnectTimer = null;
    }

    return () => {
      this.subscribers.delete(subscriber.id);

      logWsDiag("SUBSCRIBER_DETACHED", {
        subId: subscriber.id,
        remainingSubscribers: this.subscribers.size
      });

      if (this.subscribers.size === 0) {
        if (this.pendingDisconnectTimer) {
          clearTimeout(this.pendingDisconnectTimer);
        }
        logWsDiag("UNMOUNT_DEBOUNCE_TIMER_SCHEDULED", {
          delayMs: this.unmountDebounceMs,
          gen: this.currentGeneration
        });
        // Debounce unmount disconnect so React StrictMode or quick route transitions
        // do not thrash or recreate WebSocket connections.
        this.pendingDisconnectTimer = setTimeout(() => {
          this.pendingDisconnectTimer = null;
          logWsDiag("UNMOUNT_DEBOUNCE_TIMER_FIRED", {
            remainingSubscribers: this.subscribers.size,
            gen: this.currentGeneration
          });
          if (this.subscribers.size === 0) {
            this.disconnect(false, "subscribers_empty_timeout");
          }
        }, this.unmountDebounceMs);
      }
    };
  }

  // Diagnostic / Introspection methods for unit testing & debugging
  public getActiveSocket(): WebSocket | null {
    return this.activeSocket;
  }

  public getSubscriberCount(): number {
    return this.subscribers.size;
  }

  public hasPendingReconnectTimer(): boolean {
    return this.reconnectTimer !== null;
  }

  public hasPendingDisconnectTimer(): boolean {
    return this.pendingDisconnectTimer !== null;
  }

  public getGeneration(): number {
    return this.currentGeneration;
  }

  public isSocketConnected(): boolean {
    return this.isConnected;
  }

  public getManagerState(): ManagerState {
    return this.managerState;
  }

  public resetForTesting(): void {
    this.disconnect(true, "reset_for_testing");
    this.subscribers.clear();
    this.currentGeneration = 0;
    this.managerState = "IDLE";
  }
}

// Global Singleton Instance
export const haWebSocketManager = new HAWebSocketManager();
