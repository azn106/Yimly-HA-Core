import logging
import re
import sys
from typing import Any

# Pattern to scrub sensitive info
SENSITIVE_PATTERNS = [
    (re.compile(r'(password["\']?\s*:\s*["\'])([^"\']+)'), r'\1[SCRUBBED]'),
    (re.compile(r'(access_token["\']?\s*:\s*["\'])([^"\']+)'), r'\1[SCRUBBED]'),
    (re.compile(r'(refresh_token["\']?\s*:\s*["\'])([^"\']+)'), r'\1[SCRUBBED]'),
    (re.compile(r'(secret["\']?\s*:\s*["\'])([^"\']+)'), r'\1[SCRUBBED]'),
    (re.compile(r'(code["\']?\s*:\s*["\'])([^"\']+)'), r'\1[SCRUBBED]'),
    (re.compile(r'(Bearer\s+)([a-zA-Z0-9_\-\.\~]+)'), r'\1[SCRUBBED]'),
]

class SensitiveDataFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = self.scrub(record.msg)
        return True

    def scrub(self, text: str) -> str:
        for pattern, replacement in SENSITIVE_PATTERNS:
            text = pattern.sub(replacement, text)
        return text

def setup_logging() -> None:
    logger = logging.getLogger("ha_server")
    logger.setLevel(logging.INFO)
    
    # Avoid duplicate handlers
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(logging.INFO)
        
        formatter = logging.Formatter(
            '[%(asctime)s] [%(process)d] [%(levelname)s] %(name)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        handler.setFormatter(formatter)
        handler.addFilter(SensitiveDataFilter())
        
        logger.addHandler(handler)

logger = logging.getLogger("ha_server")
