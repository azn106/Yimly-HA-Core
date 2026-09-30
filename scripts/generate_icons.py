import zlib
import struct
import math
import os

def write_png(filename, width, height, pixels):
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0) # Filter type None
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            raw_data.extend((r, g, b, a))

    compressed = zlib.compress(bytes(raw_data), level=9)

    def chunk(chunk_type, data):
        length = len(data)
        crc = zlib.crc32(chunk_type + data) & 0xffffffff
        return struct.pack(">I", length) + chunk_type + data + struct.pack(">I", crc)

    png_signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr_chunk = chunk(b"IHDR", ihdr)
    idat_chunk = chunk(b"IDAT", compressed)
    iend_chunk = chunk(b"IEND", b"")

    with open(filename, "wb") as f:
        f.write(png_signature + ihdr_chunk + idat_chunk + iend_chunk)

def render_yimly_house_icon(size, is_maskable=False):
    width = size
    height = size
    pixels = [(0, 0, 0, 0)] * (width * height)

    # Colors
    c_bg_top = (255, 251, 235, 255) # #FFFBEB
    c_bg_bot = (238, 242, 255, 255) # #EEF2FF
    c_border = (224, 231, 255, 255) # #E0E7FF

    # Roof Gradient (#A78BFA -> #F472B6)
    c_roof_1 = (167, 139, 250)
    c_roof_2 = (244, 114, 182)

    # Body Gradient (#60A5FA -> #6366F1)
    c_body_1 = (96, 165, 250)
    c_body_2 = (99, 102, 241)

    # Door (#FEF08A -> #FBBF24)
    c_door_1 = (254, 240, 138)
    c_door_2 = (251, 191, 36)

    # Window (#A7F3D0 -> #34D399)
    c_win = (52, 211, 153, 255)

    # Heart (#9A3412)
    c_heart = (154, 52, 18, 255)

    sq_margin = size * (0.04 if is_maskable else 0.02)
    sq_r = (size - 2 * sq_margin) / 2.0
    sq_cx = size / 2.0
    sq_cy = size / 2.0

    for y in range(height):
        fy = y / float(height)
        for x in range(width):
            fx = x / float(width)

            # Squircle test
            nx = (x - sq_cx) / sq_r
            ny = (y - sq_cy) / sq_r
            in_squircle = (nx ** 4) + (ny ** 4) <= 1.0

            if not in_squircle:
                continue

            # Background color interpolation
            t_bg = fy
            r_bg = int(c_bg_top[0] * (1 - t_bg) + c_bg_bot[0] * t_bg)
            g_bg = int(c_bg_top[1] * (1 - t_bg) + c_bg_bot[1] * t_bg)
            b_bg = int(c_bg_top[2] * (1 - t_bg) + c_bg_bot[2] * t_bg)
            pix = (r_bg, g_bg, b_bg, 255)

            # House Base Body rect [0.25, 0.44, 0.75, 0.82]
            in_body = (0.25 <= fx <= 0.75) and (0.44 <= fy <= 0.82)

            # House Roof triangle/trapezoid [peak ~0.5, 0.20 to eaves 0.18, 0.49]
            # Line 1: left edge (0.18, 0.49) to (0.50, 0.20) => dy/dx = -0.29/0.32 = -0.90625
            # Line 2: right edge (0.82, 0.49) to (0.50, 0.20)
            in_roof = False
            if 0.20 <= fy <= 0.51:
                dx_left = (0.50 - fx)
                dx_right = (fx - 0.50)
                allowed_dx = (fy - 0.20) * (0.32 / 0.29)
                if dx_left <= allowed_dx and dx_right <= allowed_dx:
                    in_roof = True

            # Windows: [0.31..0.41, 0.50..0.60] and [0.59..0.69, 0.50..0.60]
            in_win1 = (0.31 <= fx <= 0.41) and (0.50 <= fy <= 0.60)
            in_win2 = (0.59 <= fx <= 0.69) and (0.50 <= fy <= 0.60)

            # Doorway: [0.42..0.58, 0.59..0.82] with rounded arch
            in_door = False
            if 0.42 <= fx <= 0.58 and 0.59 <= fy <= 0.82:
                if fy >= 0.65:
                    in_door = True
                else:
                    # arch check center (0.50, 0.65), radius 0.08
                    dx = fx - 0.50
                    dy = fy - 0.65
                    if dx*dx + dy*dy <= 0.08*0.08:
                        in_door = True

            # Heart inside door: around (0.50, 0.64)
            in_heart = False
            if in_door:
                hdx = (fx - 0.50) / 0.035
                hdy = (fy - 0.65) / 0.035
                if hdx*hdx + hdy*hdy <= 0.6 and fy <= 0.67:
                    in_heart = True

            if in_roof:
                t = (fy - 0.20) / 0.31
                r = int(c_roof_1[0] * (1 - t) + c_roof_2[0] * t)
                g = int(c_roof_1[1] * (1 - t) + c_roof_2[1] * t)
                b = int(c_roof_1[2] * (1 - t) + c_roof_2[2] * t)
                pix = (r, g, b, 255)
            elif in_body:
                t = (fy - 0.44) / 0.38
                r = int(c_body_1[0] * (1 - t) + c_body_2[0] * t)
                g = int(c_body_1[1] * (1 - t) + c_body_2[1] * t)
                b = int(c_body_1[2] * (1 - t) + c_body_2[2] * t)
                pix = (r, g, b, 255)

            if in_win1 or in_win2:
                pix = c_win

            if in_door:
                t = (fy - 0.59) / 0.23
                r = int(c_door_1[0] * (1 - t) + c_door_2[0] * t)
                g = int(c_door_1[1] * (1 - t) + c_door_2[1] * t)
                b = int(c_door_1[2] * (1 - t) + c_door_2[2] * t)
                pix = (r, g, b, 255)

            if in_heart:
                pix = c_heart

            pixels[y * width + x] = pix

    return pixels

if __name__ == "__main__":
    os.makedirs("public", exist_ok=True)
    print("Generating Yimly Childcare/Family Hub House PNG icons...")
    write_png("public/icon-192.png", 192, 192, render_yimly_house_icon(192))
    write_png("public/icon-512.png", 512, 512, render_yimly_house_icon(512))
    write_png("public/icon-maskable-512.png", 512, 512, render_yimly_house_icon(512, is_maskable=True))
    write_png("public/apple-touch-icon.png", 180, 180, render_yimly_house_icon(180))
    write_png("public/favicon.png", 64, 64, render_yimly_house_icon(64))
    print("Done generating Yimly House PNG icons successfully!")
