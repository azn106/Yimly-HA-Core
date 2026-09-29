import base64
import hmac
import json
import secrets
import struct
from typing import Any, Dict, Optional
from app.core.logging import logger

def _rotl32(v: int, n: int) -> int:
    return ((v << n) & 0xFFFFFFFF) | (v >> (32 - n))

def _quarter_round(y: list, a: int, b: int, c: int, d: int) -> None:
    y[b] ^= _rotl32((y[a] + y[d]) & 0xFFFFFFFF, 7)
    y[c] ^= _rotl32((y[b] + y[a]) & 0xFFFFFFFF, 9)
    y[d] ^= _rotl32((y[c] + y[b]) & 0xFFFFFFFF, 13)
    y[a] ^= _rotl32((y[d] + y[c]) & 0xFFFFFFFF, 18)

def _hsalsa20(k: bytes, in_bytes: bytes) -> bytes:
    c0, c1, c2, c3 = struct.unpack('<4I', b"expand 32-byte k")
    k0, k1, k2, k3, k4, k5, k6, k7 = struct.unpack('<8I', k)
    in0, in1, in2, in3 = struct.unpack('<4I', in_bytes)

    y = [
        c0, k0, k1, k2,
        k3, c1, in0, in1,
        in2, in3, c2, k4,
        k5, k6, k7, c3
    ]
    for _ in range(10):
        # Column round
        _quarter_round(y, 0, 4, 8, 12)
        _quarter_round(y, 5, 9, 13, 1)
        _quarter_round(y, 10, 14, 2, 6)
        _quarter_round(y, 15, 3, 7, 11)
        # Row round
        _quarter_round(y, 0, 1, 2, 3)
        _quarter_round(y, 5, 6, 7, 4)
        _quarter_round(y, 10, 11, 8, 9)
        _quarter_round(y, 15, 12, 13, 14)

    return struct.pack('<8I', y[0], y[5], y[10], y[15], y[6], y[7], y[8], y[9])

def _salsa20_block(k: bytes, nonce: bytes, counter: int) -> bytes:
    c0, c1, c2, c3 = struct.unpack('<4I', b"expand 32-byte k")
    k0, k1, k2, k3, k4, k5, k6, k7 = struct.unpack('<8I', k)
    n0, n1 = struct.unpack('<2I', nonce[:8])
    ctr0 = counter & 0xFFFFFFFF
    ctr1 = (counter >> 32) & 0xFFFFFFFF

    x = [
        c0, k0, k1, k2,
        k3, c1, n0, n1,
        ctr0, ctr1, c2, k4,
        k5, k6, k7, c3
    ]
    y = list(x)
    for _ in range(10):
        _quarter_round(y, 0, 4, 8, 12)
        _quarter_round(y, 5, 9, 13, 1)
        _quarter_round(y, 10, 14, 2, 6)
        _quarter_round(y, 15, 3, 7, 11)
        _quarter_round(y, 0, 1, 2, 3)
        _quarter_round(y, 5, 6, 7, 4)
        _quarter_round(y, 10, 11, 8, 9)
        _quarter_round(y, 15, 12, 13, 14)

    out = [(y[i] + x[i]) & 0xFFFFFFFF for i in range(16)]
    return struct.pack('<16I', *out)

def _poly1305_mac(key: bytes, msg: bytes) -> bytes:
    r_bytes = key[:16]
    s_bytes = key[16:32]
    r = int.from_bytes(r_bytes, 'little') & 0x0ffffffc0fffffff0ffffffc0fffffff
    s = int.from_bytes(s_bytes, 'little')
    p = (1 << 130) - 5

    acc = 0
    for i in range(0, len(msg), 16):
        chunk = msg[i:i+16]
        n = int.from_bytes(chunk + b'\x01', 'little')
        acc = ((acc + n) * r) % p

    tag = (acc + s) & ((1 << 128) - 1)
    return tag.to_bytes(16, 'little')

def _derive_key(secret: str) -> bytes:
    """Derive 32-byte key from secret string."""
    if isinstance(secret, bytes):
        raw = secret
    else:
        raw = secret.encode('utf-8')
    if len(raw) == 32:
        return raw
    elif len(raw) == 64:
        try:
            h = bytes.fromhex(secret)
            if len(h) == 32:
                return h
        except Exception:
            pass
    # If not 32 bytes, pad or truncate securely
    if len(raw) < 32:
        return raw.ljust(32, b'\x00')
    return raw[:32]

class EncryptionService:
    @staticmethod
    def generate_secret() -> str:
        """
        Generates a 32-character hex secret string (16 random bytes).
        When UTF-8 encoded, this produces exactly a 32-byte key required by NaCl / libsodium.
        """
        return secrets.token_hex(16)

    @staticmethod
    def encrypt(secret: str, plaintext: bytes | str | dict, nonce: Optional[bytes] = None) -> str:
        """
        Encrypts payload using standard libsodium secretbox (XSalsa20-Poly1305).
        Returns Base64-encoded string containing [24-byte nonce][16-byte tag][ciphertext].
        """
        if isinstance(plaintext, dict):
            msg_bytes = json.dumps(plaintext, separators=(',', ':')).encode('utf-8')
        elif isinstance(plaintext, str):
            msg_bytes = plaintext.encode('utf-8')
        else:
            msg_bytes = plaintext

        key_bytes = _derive_key(secret)
        if nonce is None:
            nonce = secrets.token_bytes(24)
        elif len(nonce) != 24:
            raise ValueError("Nonce must be exactly 24 bytes")

        # Try using PyNaCl if installed
        try:
            import nacl.secret
            box = nacl.secret.SecretBox(key_bytes)
            # PyNaCl SecretBox encrypt produces nonce (24 bytes) + ciphertext with tag (16 bytes)
            encrypted = box.encrypt(msg_bytes, nonce)
            return base64.b64encode(encrypted).decode('ascii')
        except ImportError:
            pass

        # Pure Python fallback
        subkey = _hsalsa20(key_bytes, nonce[:16])
        salsa_nonce = nonce[16:24]

        # Generate block 0 for Poly1305 key and initial keystream
        block0 = _salsa20_block(subkey, salsa_nonce, 0)
        poly1305_key = block0[:32]
        keystream_initial = block0[32:]

        # Encrypt plaintext
        ciphertext = bytearray(len(msg_bytes))
        # First up to 32 bytes from block 0
        take0 = min(len(msg_bytes), len(keystream_initial))
        for i in range(take0):
            ciphertext[i] = msg_bytes[i] ^ keystream_initial[i]

        # Remaining bytes from block 1, 2, ...
        pos = take0
        block_idx = 1
        while pos < len(msg_bytes):
            block = _salsa20_block(subkey, salsa_nonce, block_idx)
            take = min(len(msg_bytes) - pos, 64)
            for i in range(take):
                ciphertext[pos + i] = msg_bytes[pos + i] ^ block[i]
            pos += take
            block_idx += 1

        ciphertext_bytes = bytes(ciphertext)
        tag = _poly1305_mac(poly1305_key, ciphertext_bytes)

        # Standard crypto_secretbox_easy format: [24-byte nonce][16-byte tag][ciphertext]
        full_payload = nonce + tag + ciphertext_bytes
        return base64.b64encode(full_payload).decode('ascii')

    @staticmethod
    def decrypt(secret: str, encrypted_b64: str) -> Dict[str, Any]:
        """
        Decrypts Base64-encoded encrypted payload using secret key.
        Authenticates MAC tag and returns decoded JSON dictionary.
        Raises ValueError on decryption failure or malformed payload.
        """
        if not secret:
            raise ValueError("No encryption secret configured for this device.")

        try:
            raw = base64.b64decode(encrypted_b64)
        except Exception as e:
            raise ValueError(f"Invalid Base64 payload: {e}")

        if len(raw) < 24 + 16:
            raise ValueError("Encrypted payload too short (must contain 24-byte nonce and 16-byte MAC tag).")

        key_bytes = _derive_key(secret)
        nonce = raw[:24]

        # Try using PyNaCl if installed
        try:
            import nacl.secret
            box = nacl.secret.SecretBox(key_bytes)
            decrypted_bytes = box.decrypt(raw)
            return json.loads(decrypted_bytes.decode('utf-8'))
        except ImportError:
            pass
        except Exception as e:
            raise ValueError(f"Decryption failed: {e}")

        # Pure Python fallback
        tag = raw[24:40]
        ciphertext = raw[40:]

        subkey = _hsalsa20(key_bytes, nonce[:16])
        salsa_nonce = nonce[16:24]

        block0 = _salsa20_block(subkey, salsa_nonce, 0)
        poly1305_key = block0[:32]
        keystream_initial = block0[32:]

        # Verify MAC tag in constant time
        computed_tag = _poly1305_mac(poly1305_key, ciphertext)
        if not hmac.compare_digest(computed_tag, tag):
            raise ValueError("Ciphertext authentication failed (invalid MAC tag or secret).")

        # Decrypt ciphertext
        plaintext = bytearray(len(ciphertext))
        take0 = min(len(ciphertext), len(keystream_initial))
        for i in range(take0):
            plaintext[i] = ciphertext[i] ^ keystream_initial[i]

        pos = take0
        block_idx = 1
        while pos < len(ciphertext):
            block = _salsa20_block(subkey, salsa_nonce, block_idx)
            take = min(len(ciphertext) - pos, 64)
            for i in range(take):
                plaintext[pos + i] = ciphertext[pos + i] ^ block[i]
            pos += take
            block_idx += 1

        try:
            text = plaintext.decode('utf-8')
            return json.loads(text)
        except Exception as e:
            raise ValueError(f"Decrypted data is not valid JSON UTF-8: {e}")
