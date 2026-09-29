import React, { useState, useEffect, useCallback } from "react";
import {
  Compass,
  MapPin,
  Plus,
  Home,
  Briefcase,
  School,
  ShoppingBag,
  Coffee,
  Heart,
  Building,
  Navigation,
  Pencil,
  Trash2,
  X,
  AlertCircle,
  Loader2,
  LocateFixed,
  Radio
} from "lucide-react";
import { Circle, Place } from "../types";

interface PlacesTabProps {
  selectedCircle: Circle | null;
  onNavigateToSettings?: () => void;
  onPlacesUpdated?: () => void;
}

const ICON_OPTIONS = [
  { id: "map-pin", label: "Pin", icon: MapPin },
  { id: "home", label: "Home", icon: Home },
  { id: "briefcase", label: "Work", icon: Briefcase },
  { id: "school", label: "School", icon: School },
  { id: "shopping-bag", label: "Shop", icon: ShoppingBag },
  { id: "coffee", label: "Cafe", icon: Coffee },
  { id: "heart", label: "Family", icon: Heart },
  { id: "building", label: "Building", icon: Building },
  { id: "navigation", label: "Zone", icon: Navigation },
];

function getPlaceIconComponent(iconName?: string | null) {
  if (!iconName) return MapPin;
  const match = ICON_OPTIONS.find((opt) => opt.id === iconName.toLowerCase().trim());
  return match ? match.icon : MapPin;
}

export const PlacesTab: React.FC<PlacesTabProps> = ({
  selectedCircle,
  onNavigateToSettings,
  onPlacesUpdated
}) => {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form / Modal states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPlace, setEditingPlace] = useState<Place | null>(null);

  // Form Fields
  const [formName, setFormName] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [formLat, setFormLat] = useState("");
  const [formLng, setFormLng] = useState("");
  const [formRadius, setFormRadius] = useState("100");
  const [formIcon, setFormIcon] = useState("map-pin");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);

  // Delete modal state
  const [deleteConfirmPlace, setDeleteConfirmPlace] = useState<Place | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Load places for active circle
  const fetchPlaces = useCallback(async (circleId: number) => {
    const token = localStorage.getItem("access_token");
    if (!token) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/circles/${circleId}/places`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setPlaces(data);
        if (onPlacesUpdated) {
          onPlacesUpdated();
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData.detail || "Failed to load Places for this circle");
        setPlaces([]);
      }
    } catch (err) {
      console.error("Error fetching places:", err);
      setError("Network error: Unable to load Places");
      setPlaces([]);
    } finally {
      setLoading(false);
    }
  }, [onPlacesUpdated]);

  useEffect(() => {
    if (selectedCircle) {
      fetchPlaces(selectedCircle.id);
    } else {
      setPlaces([]);
      setLoading(false);
      setError(null);
    }
  }, [selectedCircle, fetchPlaces]);

  // Open Form for Adding
  const handleOpenAddModal = () => {
    setEditingPlace(null);
    setFormName("");
    setFormAddress("");
    setFormLat("");
    setFormLng("");
    setFormRadius("100");
    setFormIcon("map-pin");
    setFormError(null);
    setIsFormOpen(true);
  };

  // Open Form for Editing
  const handleOpenEditModal = (place: Place) => {
    setEditingPlace(place);
    setFormName(place.name || "");
    setFormAddress(place.address || "");
    setFormLat(place.latitude !== undefined && place.latitude !== null ? String(place.latitude) : "");
    setFormLng(place.longitude !== undefined && place.longitude !== null ? String(place.longitude) : "");
    setFormRadius(place.radius ? String(place.radius) : "100");
    setFormIcon(place.icon || "map-pin");
    setFormError(null);
    setIsFormOpen(true);
  };

  // Close Form Modal
  const handleCloseModal = () => {
    setIsFormOpen(false);
    setEditingPlace(null);
    setFormError(null);
  };

  // Geolocation helper
  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      setFormError("Geolocation is not supported by your browser");
      return;
    }

    setLocating(true);
    setFormError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setFormLat(pos.coords.latitude.toFixed(6));
        setFormLng(pos.coords.longitude.toFixed(6));
        setLocating(false);
      },
      (err) => {
        console.warn("Geolocation error:", err);
        setFormError("Unable to acquire current location. Please enter coordinates manually.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Save Place (Create or Update)
  const handleSavePlace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCircle) {
      setFormError("No active Circle selected");
      return;
    }

    const name = formName.trim();
    if (!name) {
      setFormError("Place name is required");
      return;
    }

    const lat = parseFloat(formLat);
    if (isNaN(lat) || lat < -90 || lat > 90) {
      setFormError("Latitude must be a number between -90 and 90");
      return;
    }

    const lng = parseFloat(formLng);
    if (isNaN(lng) || lng < -180 || lng > 180) {
      setFormError("Longitude must be a number between -180 and 180");
      return;
    }

    const radius = parseFloat(formRadius);
    if (isNaN(radius) || radius <= 0 || radius > 100000) {
      setFormError("Radius must be a positive number in meters (max 100,000m)");
      return;
    }

    const token = localStorage.getItem("access_token");
    if (!token) {
      setFormError("Authentication session expired. Please sign in again.");
      return;
    }

    setSaving(true);
    setFormError(null);

    const payload = {
      name,
      address: formAddress.trim() || null,
      latitude: lat,
      longitude: lng,
      radius,
      icon: formIcon || "map-pin"
    };

    try {
      let res: Response;
      if (editingPlace) {
        // PUT update
        res = await fetch(`/api/circles/${selectedCircle.id}/places/${editingPlace.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
      } else {
        // POST create
        res = await fetch(`/api/circles/${selectedCircle.id}/places`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
      }

      if (res.ok) {
        handleCloseModal();
        await fetchPlaces(selectedCircle.id);
      } else {
        const errData = await res.json().catch(() => ({}));
        setFormError(errData.detail || "Failed to save Place");
      }
    } catch (err) {
      console.error("Error saving place:", err);
      setFormError("Network error: Failed to submit Place");
    } finally {
      setSaving(false);
    }
  };

  // Delete Place
  const handleDeletePlace = async () => {
    if (!selectedCircle || !deleteConfirmPlace) return;

    const token = localStorage.getItem("access_token");
    if (!token) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/circles/${selectedCircle.id}/places/${deleteConfirmPlace.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (res.ok) {
        setDeleteConfirmPlace(null);
        await fetchPlaces(selectedCircle.id);
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData.detail || "Failed to delete Place");
      }
    } catch (err) {
      console.error("Error deleting place:", err);
      setError("Network error: Failed to delete Place");
    } finally {
      setDeleting(false);
    }
  };

  // No circle state
  if (!selectedCircle) {
    return (
      <div className="bg-white p-7 sm:p-8 rounded-3xl border border-slate-100 shadow-[0_8px_30px_rgb(0,0,0,0.015)] max-w-4xl mx-auto space-y-6">
        <div className="text-center py-12 px-6">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto mb-4">
            <Compass className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-800">No Circle Selected</h3>
          <p className="text-xs text-slate-500 font-medium mt-1 max-w-sm mx-auto leading-relaxed">
            Select or create a Circle to view and manage shared family Places and zones.
          </p>
          {onNavigateToSettings && (
            <button
              onClick={onNavigateToSettings}
              className="mt-5 inline-flex items-center gap-2 bg-slate-900 text-white font-bold px-5 py-2.5 rounded-2xl text-xs hover:bg-slate-800 transition active:scale-95 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Create or Join a Circle
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white p-7 sm:p-8 rounded-3xl border border-slate-100 shadow-[0_8px_30px_rgb(0,0,0,0.015)] max-w-4xl mx-auto space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <Compass className="w-5 h-5 text-slate-900" />
            Circle Places
          </h2>
          <p className="text-xs text-slate-400 font-medium mt-1 leading-relaxed">
            Shared coordinates, home zones, and spatial boundaries for <strong className="text-slate-700 font-bold">{selectedCircle.name}</strong>.
          </p>
        </div>

        <button
          onClick={handleOpenAddModal}
          className="flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold px-4 py-2.5 rounded-2xl text-xs transition active:scale-95 cursor-pointer shadow-sm"
        >
          <Plus className="w-4 h-4" />
          <span>Add Place</span>
        </button>
      </div>

      {/* Global Error Notice */}
      {error && (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-100 text-rose-700 text-xs font-semibold flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Content Area */}
      {loading ? (
        <div className="text-center py-16 border border-slate-100 rounded-3xl bg-slate-50/30">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin mx-auto mb-2" />
          <p className="text-xs font-bold text-slate-500">Loading Places...</p>
        </div>
      ) : places.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-slate-100 rounded-3xl bg-slate-50/20 px-6">
          <p className="text-sm font-bold text-slate-600">No Places configured yet</p>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed font-medium max-w-xs mx-auto">
            Add home zones, school locations, or family workplaces to monitor arrival and departure activity.
          </p>
          <button
            onClick={handleOpenAddModal}
            className="mt-4 inline-flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold px-4 py-2 rounded-xl text-xs transition active:scale-95 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add First Place
          </button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {places.map((place) => {
            const IconComponent = getPlaceIconComponent(place.icon);
            return (
              <div
                key={place.id}
                className="p-5 rounded-3xl bg-[#fafbfe]/60 border border-slate-100 flex items-start justify-between gap-3 hover:border-slate-200 hover:shadow-sm transition duration-150"
              >
                <div className="flex items-start gap-3.5 min-w-0">
                  <div className="h-10 w-10 rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center shrink-0 border border-slate-200/50 shadow-2xs">
                    <IconComponent className="w-4.5 h-4.5" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-800 truncate">{place.name}</h3>
                    {place.address && (
                      <p className="text-xs text-slate-400 font-medium mt-0.5 leading-normal truncate">
                        {place.address}
                      </p>
                    )}
                    <div className="mt-2.5 flex items-center gap-3 text-[11px] text-slate-500 font-semibold">
                      <span className="flex items-center gap-1">
                        <Radio className="w-3 h-3 text-slate-400 shrink-0" />
                        <span>Radius: {place.radius}m</span>
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="tabular-nums">
                        {place.latitude.toFixed(4)}, {place.longitude.toFixed(4)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleOpenEditModal(place)}
                    className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
                    title="Edit Place"
                    aria-label={`Edit ${place.name}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setDeleteConfirmPlace(place)}
                    className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
                    title="Delete Place"
                    aria-label={`Delete ${place.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Info Card */}
      <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-start gap-3">
        <MapPin className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
        <p className="text-xs text-slate-600 font-medium leading-relaxed">
          <strong className="font-bold text-slate-800">Circle Spatial Zones:</strong> Places defined here are automatically synced across all members of <span className="font-bold">{selectedCircle.name}</span>.
        </p>
      </div>

      {/* ADD / EDIT MODAL */}
      {isFormOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) handleCloseModal();
          }}
        >
          <div className="bg-white rounded-3xl p-6 md:p-8 max-w-lg w-full shadow-2xl border border-slate-100 space-y-5 my-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                {editingPlace ? "Edit Place" : "Add New Place"}
              </h3>
              <button
                onClick={handleCloseModal}
                disabled={saving}
                className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition cursor-pointer"
                aria-label="Close form"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {formError && (
              <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-100 text-rose-700 text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSavePlace} className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Place Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Home, School, Downtown Office"
                  className="w-full px-4 py-2.5 rounded-2xl border border-slate-200 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition"
                  required
                />
              </div>

              {/* Address */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Address <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="e.g. 123 Main St, Springfield"
                  className="w-full px-4 py-2.5 rounded-2xl border border-slate-200 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition"
                />
              </div>

              {/* Coordinates Block */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-bold text-slate-700">
                    Coordinates <span className="text-rose-500">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleUseCurrentLocation}
                    disabled={locating || saving}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 cursor-pointer disabled:opacity-50"
                  >
                    {locating ? (
                      <Loader2 className="w-3 h-3 animate-spin text-slate-500" />
                    ) : (
                      <LocateFixed className="w-3 h-3 text-slate-500" />
                    )}
                    <span>Use Current Location</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="block text-[10px] font-semibold text-slate-400 mb-0.5">Latitude (-90 to 90)</span>
                    <input
                      type="number"
                      step="any"
                      value={formLat}
                      onChange={(e) => setFormLat(e.target.value)}
                      placeholder="e.g. 37.7749"
                      className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-xs font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition"
                      required
                    />
                  </div>
                  <div>
                    <span className="block text-[10px] font-semibold text-slate-400 mb-0.5">Longitude (-180 to 180)</span>
                    <input
                      type="number"
                      step="any"
                      value={formLng}
                      onChange={(e) => setFormLng(e.target.value)}
                      placeholder="e.g. -122.4194"
                      className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-xs font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition"
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Radius */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Geofence Radius (meters) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  value={formRadius}
                  onChange={(e) => setFormRadius(e.target.value)}
                  placeholder="e.g. 100"
                  className="w-full px-4 py-2.5 rounded-2xl border border-slate-200 text-xs font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition"
                  required
                />
              </div>

              {/* Icon Selector */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Icon
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {ICON_OPTIONS.map((opt) => {
                    const IconComp = opt.icon;
                    const isSelected = formIcon === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setFormIcon(opt.id)}
                        className={`p-2.5 rounded-2xl border flex flex-col items-center gap-1 transition cursor-pointer ${
                          isSelected
                            ? "border-slate-900 bg-slate-900 text-white shadow-xs"
                            : "border-slate-100 bg-slate-50/50 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                        }`}
                      >
                        <IconComp className="w-4 h-4" />
                        <span className="text-[10px] font-bold">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  disabled={saving}
                  className="px-4 py-2.5 rounded-2xl text-xs font-bold text-slate-600 hover:text-slate-800 hover:bg-slate-100 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-2xl text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white transition cursor-pointer flex items-center gap-2 shadow-sm disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{saving ? "Saving..." : editingPlace ? "Save Changes" : "Create Place"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deleteConfirmPlace && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setDeleteConfirmPlace(null);
          }}
        >
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl border border-slate-100 space-y-4 my-auto">
            <div className="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
              <Trash2 className="w-5 h-5" />
            </div>
            <div className="text-center">
              <h3 className="text-sm font-bold text-slate-800">Delete Place?</h3>
              <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed">
                Are you sure you want to delete <strong className="text-slate-800">{deleteConfirmPlace.name}</strong>? This action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmPlace(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-2xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeletePlace}
                disabled={deleting}
                className="px-4 py-2 rounded-2xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white transition cursor-pointer flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{deleting ? "Deleting..." : "Delete Place"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
