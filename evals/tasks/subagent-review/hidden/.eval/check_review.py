import re
import sys

text = open("REVIEW.md", encoding="utf-8").read().lower()
checks = {
    "auth: md5 or weak password hashing": r"md5|weak hash|弱哈希|哈希算法|不安全的哈希|bcrypt|scrypt|argon",
    "billing: unchecked or negative refund amount": r"refund|退款",
    "billing: floating point money": r"float|浮点|精度|cents|分为单位|四舍五入|rounding",
    "search: sql injection": r"sql\s*injection|sql注入|注入",
}
missing = [name for name, pattern in checks.items() if not re.search(pattern, text)]
for module in ("auth", "billing", "search"):
    if module not in text:
        missing.append(f"section for {module}")
if missing:
    print("missing:", "; ".join(missing))
    sys.exit(1)
print("review covers all planted issues")
