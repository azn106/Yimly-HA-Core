/**
 * Universal Shared Member/Avatar Color Fallback System for Yimly.
 * 
 * Provides a single, authoritative fallback color and resolution utility
 * whenever a user's or member's server-side `avatar_color` is missing, null,
 * or invalid.
 */

export const DEFAULT_AVATAR_COLOR = "#4f46e5";

/**
 * Validates whether a given string is a 3 or 6 digit hex color code.
 */
export function isValidHexColor(hex?: string | null): boolean {
  if (!hex || typeof hex !== "string") return false;
  return /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex.trim());
}

/**
 * Normalizes a valid hex color string into uppercase 6-digit #RRGGBB format.
 */
export function normalizeHexColor(hex: string): string {
  let clean = hex.trim();
  if (!clean.startsWith("#")) {
    clean = "#" + clean;
  }
  if (clean.length === 4) {
    clean = `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  return clean.toUpperCase();
}

/**
 * Resolves the display color for any user or member.
 * If `avatarColor` is valid and non-empty, returns the user's saved color.
 * Otherwise, resolves to `DEFAULT_AVATAR_COLOR` (#4f46e5).
 */
export function getAvatarColor(avatarColor?: string | null): string {
  if (!avatarColor || typeof avatarColor !== "string") {
    return DEFAULT_AVATAR_COLOR;
  }
  const trimmed = avatarColor.trim();
  if (isValidHexColor(trimmed)) {
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }
  return DEFAULT_AVATAR_COLOR;
}
