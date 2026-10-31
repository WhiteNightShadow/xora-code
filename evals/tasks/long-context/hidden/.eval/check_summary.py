import json
import re
import sys

answers = json.load(open(".eval/answers.json", encoding="utf-8"))
lines = open("SUMMARY.md", encoding="utf-8").read().splitlines()
wrong = []
for number, answer in answers.items():
    row = next((line for line in lines if re.search(rf"第{number}章", line)), None)
    if row is None:
        wrong.append(f"第{number}章: missing")
    elif answer["code"] not in row or answer["risk"] not in row:
        wrong.append(f"第{number}章: want {answer['code']} / {answer['risk']}")
if wrong:
    print("\n".join(wrong))
    sys.exit(1)
print("12 chapters right")
