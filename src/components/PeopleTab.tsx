import React, { useState, useEffect } from "react";
import { CircleMember, HADevice } from "../types";
import { UserCheck, Plus, Edit2, Trash2, Smartphone, Battery, Check, X, Shield, Radio, Sparkles } from "lucide-react";
import { getAvatarColor, DEFAULT_AVATAR_COLOR } from "../lib/avatarColor";

interface PeopleTabProps {
  members: CircleMember[];
  loading: boolean;
  circleId?: number;
  onSelectMember?: (member: CircleMember) => void;
  onRefreshMembers?: () => void;
}

const COLOR_PRESETS = [
  { name: "Pastel Red", hex: "#FF9AA2" },
  { name: "Pastel Orange", hex: "#FFB347" },
  { name: "Pastel Yellow", hex: "#FDFF8F" },
  { name: "Pastel Green", hex: "#A8E6CF" },
  { name: "Pastel Cyan", hex: "#A8ECE7" },
  { name: "Pastel Blue", hex: "#B8B5FF" },
  { name: "Pastel Purple", hex: "#D47AE8" }
];

export const PeopleTab: React.FC<PeopleTabProps> = ({
  members,
  loading,
  circleId,
  onSelectMember,
  onRefreshMembers
}) => {
  const [availableDevices, setAvailableDevices] = useState<HADevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  
  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<CircleMember | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [avatarColor, setAvatarColor] = useState(DEFAULT_AVATAR_COLOR);
  const [profilePictureUrl, setProfilePictureUrl] = useState("");
  const [assignedEntityId, setAssignedEntityId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Fetch discovered HA devices
  const fetchAvailableDevices = async () => {
    const token = localStorage.getItem("access_token");
    if (!token) return;
    try {
      setLoadingDevices(true);
      const res = await fetch("/api/ha/devices", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAvailableDevices(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.warn("Failed to fetch available HA devices:", err);
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    fetchAvailableDevices();
  }, []);

  const openAddModal = () => {
    setEditingMember(null);
    setDisplayName("");
    setAvatarColor(COLOR_PRESETS[Math.floor(Math.random() * COLOR_PRESETS.length)].hex);
    setProfilePictureUrl("");
    setAssignedEntityId("");
    setErrorMsg("");
    setModalOpen(true);
    fetchAvailableDevices();
  };

  const openEditModal = (member: CircleMember, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingMember(member);
    setDisplayName(member.display_name || "");
    setAvatarColor(member.avatar_color || DEFAULT_AVATAR_COLOR);
    setProfilePictureUrl(member.profile_picture_url || "");
    setAssignedEntityId(member.assigned_entity_id || (member.devices?.[0]?.entity_id || ""));
    setErrorMsg("");
    setModalOpen(true);
    fetchAvailableDevices();
  };

  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) {
      setErrorMsg("Please enter a member display name.");
      return;
    }
    if (!circleId) {
      setErrorMsg("No active Circle selected.");
      return;
    }

    const token = localStorage.getItem("access_token");
    if (!token) return;

    setSaving(true);
    setErrorMsg("");

    try {
      if (editingMember) {
        // Update existing member
        const res = await fetch(`/api/circles/${circleId}/members/${editingMember.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            display_name: displayName.trim(),
            avatar_color: avatarColor,
            profile_picture_url: profilePictureUrl.trim() || null,
            assigned_entity_id: assignedEntityId || null
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Failed to update member");
        }
      } else {
        // Create new member
        const res = await fetch(`/api/circles/${circleId}/members`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            display_name: displayName.trim(),
            avatar_color: avatarColor,
            profile_picture_url: profilePictureUrl.trim() || null,
            assigned_entity_id: assignedEntityId || null
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Failed to create member");
        }
      }

      setModalOpen(false);
      onRefreshMembers?.();
    } catch (err: any) {
      setErrorMsg(err.message || "An unexpected error occurred.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMember = async () => {
    if (!editingMember || !circleId) return;
    if (!confirm(`Are you sure you want to remove "${editingMember.display_name}" from this circle?`)) return;

    const token = localStorage.getItem("access_token");
    if (!token) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/circles/${circleId}/members/${editingMember.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Failed to delete member");
      }
      setModalOpen(false);
      onRefreshMembers?.();
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to delete member");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white p-7 sm:p-8 rounded-3xl border border-slate-100 shadow-[0_8px_30px_rgb(0,0,0,0.015)] max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-indigo-600" />
            Family Members
          </h2>
          <p className="text-xs text-slate-400 font-semibold mt-1 leading-relaxed">
            Manage your family profiles and assign real Home Assistant devices/trackers. Click any member to focus on the map.
          </p>
        </div>

        {circleId && (
          <button
            onClick={openAddModal}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-xs font-bold transition shadow-sm self-start sm:self-auto cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Add Member
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-xs text-slate-400 font-bold tracking-wide">
          Loading members...
        </div>
      ) : members.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-slate-100 rounded-3xl bg-slate-50/20 px-6">
          <p className="text-sm font-bold text-slate-600">No members in this Circle</p>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed font-semibold max-w-xs mx-auto mb-4">
            Create family member profiles or invite members by sharing your Circle's invite code.
          </p>
          {circleId && (
            <button
              onClick={openAddModal}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Create First Member
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-100/70 border border-slate-100/80 rounded-2xl overflow-hidden bg-white/45 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.01)]">
          {members.map((member) => {
            const avatarBg = getAvatarColor(member.avatar_color);
            const assignedDevice = member.devices?.[0];
            const hasLocation = assignedDevice && assignedDevice.latitude != null && assignedDevice.longitude != null;

            return (
              <div
                key={member.id}
                onClick={() => onSelectMember?.(member)}
                className="flex items-center justify-between p-4 hover:bg-slate-50/70 transition duration-150 cursor-pointer group gap-4"
              >
                {/* Left Side: Avatar & Display Name */}
                <div className="flex items-center gap-3.5 min-w-0">
                  <div 
                    className="h-11 w-11 text-white font-black text-sm flex items-center justify-center select-none transition-all duration-300 overflow-hidden shrink-0 group-hover:scale-105"
                    style={{ 
                      backgroundColor: avatarBg, 
                      clipPath: "url(#squircle-clip-app)",
                      filter: `drop-shadow(0 2px 4px ${avatarBg}40)`
                    }}
                  >
                    {member.profile_picture_url ? (
                      <img
                        src={member.profile_picture_url}
                        alt={member.display_name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                        style={{ clipPath: "url(#squircle-clip-app)" }}
                      />
                    ) : (
                      member.display_name.charAt(0).toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-slate-800 group-hover:text-indigo-600 transition truncate">
                        {member.display_name}
                      </p>
                      {member.is_owner && (
                        <span className="text-[10px] font-extrabold uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200/60 px-1.5 py-0.2 rounded-md">
                          Owner
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 font-medium truncate mt-0.5">
                      {member.assigned_entity_id ? (
                        <span className="text-indigo-600/90 font-semibold flex items-center gap-1.5">
                          <Smartphone className="w-3 h-3 inline" />
                          {member.assigned_entity_id}
                          {assignedDevice?.location_visibility && (
                            <span className="text-[10px] text-slate-400 font-normal">
                              ({assignedDevice.location_visibility === "me_only" ? "Private" : "Circle Shared"})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">No location device assigned.</span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Right Side: Device Status & Action Buttons */}
                <div className="flex items-center gap-2.5 shrink-0">
                  {assignedDevice ? (
                    <div className="flex flex-col items-end gap-1 bg-slate-50 border border-slate-200/60 px-3 py-1.5 rounded-xl">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${hasLocation ? "bg-emerald-500 animate-pulse" : "bg-amber-400"}`} />
                        <span className="text-xs font-bold text-slate-700">
                          {assignedDevice.device_name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-500 font-semibold">
                        {assignedDevice.state && (
                          <span className="capitalize px-1.5 py-0.2 bg-slate-100 rounded text-slate-600 font-bold">
                            {assignedDevice.state.replace(/_/g, " ")}
                          </span>
                        )}
                        {assignedDevice.battery != null && (
                          <span className="flex items-center gap-0.5">
                            <Battery className="w-3.5 h-3.5 text-slate-400" />
                            {assignedDevice.battery}%
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-[11px] font-semibold text-slate-400 bg-slate-100/70 border border-slate-200/50 px-2.5 py-1.5 rounded-xl">
                      No location device assigned.
                    </span>
                  )}

                  <button
                    onClick={(e) => openEditModal(member, e)}
                    className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50/80 rounded-lg transition cursor-pointer"
                    title="Edit Member & Assign Device"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Member Edit / Create Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 sm:p-7 max-w-md w-full shadow-2xl border border-slate-100 space-y-5 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-indigo-600" />
                {editingMember ? "Edit Family Member" : "Add Family Member"}
              </h3>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold rounded-xl">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleSaveMember} className="space-y-4">
              {/* Display Name */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Member Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Robin, Jane, Kid"
                  required
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition"
                />
              </div>

              {/* Avatar Colour */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Avatar Colour
                </label>
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  {COLOR_PRESETS.map((p) => (
                    <button
                      type="button"
                      key={p.hex}
                      onClick={() => setAvatarColor(p.hex)}
                      className={`w-7 h-7 rounded-lg transition-transform ${avatarColor.toUpperCase() === p.hex.toUpperCase() ? "scale-115 ring-2 ring-indigo-500 ring-offset-2" : "hover:scale-105"}`}
                      style={{ backgroundColor: p.hex }}
                      title={p.name}
                    />
                  ))}
                </div>
                <input
                  type="text"
                  value={avatarColor}
                  onChange={(e) => setAvatarColor(e.target.value)}
                  placeholder="#FF9AA2"
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700"
                />
              </div>

              {/* Profile Picture URL */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Profile Picture URL (Optional)
                </label>
                <input
                  type="url"
                  value={profilePictureUrl}
                  onChange={(e) => setProfilePictureUrl(e.target.value)}
                  placeholder="https://example.com/avatar.jpg"
                  className="w-full px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-700 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Home Assistant Device Assignment */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-bold text-slate-700">
                    Assigned Home Assistant Device / Tracker
                  </label>
                  {loadingDevices && (
                    <span className="text-[10px] text-slate-400 animate-pulse font-medium">Scanning HA...</span>
                  )}
                </div>
                
                <select
                  value={assignedEntityId}
                  onChange={(e) => setAssignedEntityId(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition"
                >
                  <option value="">-- No Device Assigned (Unassigned) --</option>
                  {availableDevices.length === 0 && (
                    <option disabled value="">No Home Assistant location devices available.</option>
                  )}
                  {availableDevices.map((dev) => (
                    <option key={dev.entity_id} value={dev.entity_id}>
                      {dev.device_name} ({dev.entity_id}) - {dev.is_available ? `Online (${dev.state})` : "Unavailable"} {dev.battery != null ? `• ${dev.battery}%` : ""}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1 font-medium">
                  Select a live location tracker discovered from Home Assistant Core to power this member's map marker.
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                {editingMember && !editingMember.is_owner ? (
                  <button
                    type="button"
                    onClick={handleDeleteMember}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-3 py-2 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-bold transition cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                ) : <div />}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-xs font-bold transition shadow-sm cursor-pointer disabled:opacity-50"
                  >
                    {saving ? "Saving..." : editingMember ? "Save Changes" : "Create Member"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
