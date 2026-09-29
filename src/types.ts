export interface UserInfo {
  id: number;
  username: string;
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
}

export interface MemberDeviceLocation {
  entity_id: string;
  device_name: string;
  latitude: number;
  longitude: number;
  battery?: number | string | null;
  charging?: boolean | null;
  accuracy?: number | null;
  state?: string;
  last_updated: string;
  platform?: string;
  location_visibility?: "family" | "me_only";
  map_icon?: string;
  allow_find_my_device?: boolean;
  is_default?: boolean;
}

export interface UserDevice {
  entity_id: string;
  name: string;
  platform: string;
  battery: number | string;
  charging?: boolean | null;
  state: string;
  last_updated: string;
  location_visibility: "family" | "me_only";
  map_icon: string;
  allow_find_my_device?: boolean;
  is_default?: boolean;
}

export interface CircleMember {
  id: number;
  username: string;
  display_name: string;
  avatar_color?: string | null;
  profile_picture_url?: string | null;
  assigned_entity_id?: string | null;
  is_owner?: boolean;
  devices: MemberDeviceLocation[];
}

export interface HADevice {
  entity_id: string;
  device_name: string;
  state: string;
  is_available: boolean;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  battery?: number | null;
  charging?: boolean | null;
  platform?: string;
  last_updated?: string;
  map_icon?: string;
}

export interface Circle {
  id: number;
  name: string;
  owner_id: number;
  invite_code: string;
  created_at: string;
}

export interface Place {
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

export interface LocationHistoryItem {
  id: string;
  entity_id: string;
  user_id: number;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  speed?: number | null;
  bearing?: number | null;
  battery_level?: number | string | null;
  timestamp: string;
}

export type AlertType = "arrival" | "departure" | "stop_sharing" | "low_battery" | "device_offline";

export interface Alert {
  id: number;
  circle_id: number;
  user_id: number;
  target_user_id?: number | null;
  alert_type: AlertType;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

