import React from "react";
import {
  Bell,
  Info,
  MapPin,
  MapPinOff,
  BatteryLow,
  WifiOff,
  LogOut,
  RefreshCw,
  AlertTriangle,
  CircleAlert,
  CheckCircle2
} from "lucide-react";
import { Alert, Circle, CircleMember } from "../types";
import { getAvatarColor } from "../lib/avatarColor";

interface AlertsTabProps {
  alerts: Alert[];
  loading: boolean;
  error: string | null;
  onMarkAsRead: (alertId: number) => void;
  selectedCircle: Circle | null;
  circleMembers: CircleMember[];
}

export const AlertsTab: React.FC<AlertsTabProps> = ({
  alerts,
  loading,
  error,
  onMarkAsRead,
  selectedCircle,
  circleMembers
}) => {
  // Map alert type to system icons
  const getAlertIcon = (type: string) => {
    switch (type) {
      case "arrival":
        return <MapPin className="w-4 h-4 text-emerald-600" />;
      case "departure":
        return <LogOut className="w-4 h-4 text-blue-600" />;
      case "stop_sharing":
        return <MapPinOff className="w-4 h-4 text-rose-600" />;
      case "low_battery":
        return <BatteryLow className="w-4 h-4 text-amber-500 animate-pulse" />;
      case "device_offline":
        return <WifiOff className="w-4 h-4 text-slate-500" />;
      default:
        return <Bell className="w-4 h-4 text-indigo-600" />;
    }
  };

  const getAlertBgClass = (type: string) => {
    switch (type) {
      case "arrival":
        return "bg-emerald-50 border-emerald-100";
      case "departure":
        return "bg-blue-50 border-blue-100";
      case "stop_sharing":
        return "bg-rose-50 border-rose-100";
      case "low_battery":
        return "bg-amber-50 border-amber-100";
      case "device_offline":
        return "bg-slate-50 border-slate-100";
      default:
        return "bg-indigo-50 border-indigo-100";
    }
  };

  // Format relative time helper
  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return "Unknown time";
      
      const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
      if (seconds < 60) return "Just now";
      
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return "Unknown time";
    }
  };

  const unreadAlerts = alerts.filter((a) => !a.read);

  return (
    <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-100 shadow-[0_8px_30px_rgb(0,0,0,0.015)] max-w-4xl mx-auto space-y-6">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
            <Bell className="w-5 h-5 text-indigo-600" />
            Circle Alerts
          </h2>
          <p className="text-xs text-slate-400 font-bold mt-1 leading-relaxed">
            {selectedCircle 
              ? `Stay updated on "${selectedCircle.name}" family movements, low batteries, and geofence events.`
              : "Access safety updates once connected to a Family Circle."}
          </p>
        </div>

        {selectedCircle && alerts.length > 0 && (
          <span className="text-[11px] font-black uppercase tracking-wider text-slate-500 bg-slate-100 px-3.5 py-1.5 rounded-full self-start sm:self-center">
            {unreadAlerts.length} unread &bull; {alerts.length} total
          </span>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
          <RefreshCw className="w-7 h-7 text-indigo-600 animate-spin" />
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Retrieving alert logs...</p>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="p-5 rounded-3xl bg-rose-50 border border-rose-100 text-rose-700 flex gap-3 text-xs">
          <AlertTriangle className="w-4.5 h-4.5 text-rose-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-extrabold block mb-0.5">Failed to sync:</span>
            <p className="text-rose-600 font-semibold">{error}</p>
          </div>
        </div>
      )}

      {/* Content Scenarios */}
      {!selectedCircle ? (
        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-slate-100 rounded-3xl text-center p-8 bg-[#fafbfe]/20">
          <div className="h-14 w-14 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center border border-slate-100 mb-4 shadow-sm">
            <CircleAlert className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-wide">No Circle Selected</h3>
          <p className="text-xs text-slate-400 max-w-xs mt-1.5 leading-relaxed font-bold">
            Please join or create a Family Circle under the settings tab first to access automated family alert logs.
          </p>
        </div>
      ) : !loading && alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-slate-100 rounded-3xl text-center p-8 bg-[#fafbfe]/20">
          <div className="h-14 w-14 rounded-2xl bg-indigo-50/60 text-indigo-600 flex items-center justify-center border border-indigo-100/20 mb-4 shadow-sm">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-wide">All Caught Up</h3>
          <p className="text-xs text-slate-400 max-w-xs mt-1.5 leading-relaxed font-bold">
            There are currently no active alerts for your family circle. Battery updates, arrivals, and exits will appear here when they transition.
          </p>
        </div>
      ) : (
        !loading && (
          <div className="space-y-3">
            {alerts.map((alert) => {
              // Find matching member in current circle members
              const member = circleMembers.find((m) => m.id === alert.target_user_id);
              const avatarColor = getAvatarColor(member?.avatar_color);

              return (
                <div
                  key={alert.id}
                  onClick={() => !alert.read && onMarkAsRead(alert.id)}
                  className={`group relative p-4 rounded-2xl border transition-all duration-150 flex items-start gap-4 cursor-pointer ${
                    alert.read
                      ? "bg-slate-50/40 border-slate-100/70 hover:bg-slate-50/80"
                      : "bg-white border-indigo-100/80 shadow-[0_4px_16px_rgba(99,102,241,0.03)] hover:border-indigo-200"
                  }`}
                >
                  {/* Unread Left Border Highlight */}
                  {!alert.read && (
                    <div className="absolute left-0 top-3 bottom-3 w-1 bg-indigo-500 rounded-r-md" />
                  )}

                  {/* Avatar & System Type Badge Overlay */}
                  <div className="relative shrink-0 select-none">
                    <div
                      className="w-10 h-10 text-white font-extrabold text-xs flex items-center justify-center overflow-hidden"
                      style={{
                        backgroundColor: avatarColor,
                        clipPath: "url(#squircle-clip-app)"
                      }}
                    >
                      {member?.profile_picture_url ? (
                        <img
                          src={member.profile_picture_url}
                          alt={member.display_name}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                          style={{ clipPath: "url(#squircle-clip-app)" }}
                        />
                      ) : (
                        (member?.display_name || alert.title.split(":")[1]?.trim() || "U").charAt(0).toUpperCase()
                      )}
                    </div>
                    {/* Floating Alert Icon Badge */}
                    <div className={`absolute -bottom-1 -right-1 p-1 rounded-md border shadow-sm ${getAlertBgClass(alert.alert_type)}`}>
                      {getAlertIcon(alert.alert_type)}
                    </div>
                  </div>

                  {/* Alert Text Details */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-black uppercase tracking-wide truncate ${
                        alert.read ? "text-slate-500" : "text-indigo-600"
                      }`}>
                        {alert.title}
                      </span>
                      <span className="text-[10px] font-bold text-slate-400 shrink-0 select-none">
                        {formatTime(alert.created_at)}
                      </span>
                    </div>
                    <p className={`text-xs leading-relaxed font-bold ${
                      alert.read ? "text-slate-400" : "text-slate-700"
                    }`}>
                      {alert.message}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Info Footnote block */}
      <div className="p-5 rounded-3xl bg-slate-50/50 border border-slate-100/60 flex gap-3 text-xs text-slate-600 select-none">
        <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-extrabold text-slate-800 block mb-0.5">Real-time Telemetry Processing:</span>
          <p className="mt-1 text-slate-400 leading-relaxed font-semibold">
            The Family Circle sharing layer reads webhook payload signals from registered devices. Safety notifications are processed server-side and updated as soon as device tracker states shift.
          </p>
        </div>
      </div>
    </div>
  );
};
