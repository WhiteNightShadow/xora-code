import re
import sys

text = open("ENV.md", encoding="utf-8").read()
expected = {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_NAME": "orders",
    "REDIS_URL": "redis://localhost:6379",
    "CACHE_TTL": "300",
    "PORT": "8080",
    "LOG_LEVEL": "info",
    "FEATURE_BETA": "false",
    "SMTP_HOST": "必填",
    "MAIL_FROM": "orders@example.com",
}
missing = []
for name, default in expected.items():
    rows = [line for line in text.splitlines() if re.search(rf"\b{re.escape(name)}\b", line)]
    if not any(default.lower() in row.lower() for row in rows):
        missing.append(f"{name} (default {default})")
if missing:
    print("missing or wrong:", ", ".join(missing))
    sys.exit(1)
print("all", len(expected), "variables found")
