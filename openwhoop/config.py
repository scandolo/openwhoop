"""Load configuration from .env file."""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

WHOOP_DEVICE_NAME: str = os.getenv("WHOOP_DEVICE_NAME", "")
DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///openwhoop.db")
