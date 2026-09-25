#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 patches/client_rules.json 施加到**你自己持有**的官方客户端构建上。

用法:
    python tools/apply_client_rules.py --client "<官方客户端构建目录>"          # 施加
    python tools/apply_client_rules.py --client "<...>" --check                 # 只检查，不写盘
    python tools/apply_client_rules.py --client "<...>" --force                 # 忽略 sha 不匹配

判定逻辑:
    输入 sha256 == sha256_in   → 施加，并校验结果 == sha256_out（完全一致）
    输入 sha256 == sha256_out  → 跳过（幂等，重复跑安全）
    其它（你的版本不同）       → 仍逐条试施加；任一条 find 未唯一命中就报错、不写盘

脚本全程离线：不联网、不下载任何东西。规则里不含任何原版文件。
"""
import argparse
import hashlib
import io
import json
import os
import sys


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client", required=True, help="官方客户端构建目录（含 index.html）")
    ap.add_argument("--rules", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "..", "patches", "client_rules.json"))
    ap.add_argument("--check", action="store_true", help="只检查不写盘")
    ap.add_argument("--force", action="store_true", help="输入 sha 不匹配也继续")
    args = ap.parse_args()

    root = os.path.abspath(args.client)
    if not os.path.isdir(root):
        sys.exit("目录不存在: " + root)
    rules_path = os.path.abspath(args.rules)
    doc = json.load(io.open(rules_path, encoding="utf-8"))

    ok = skipped = failed = 0
    for ent in doc["files"]:
        rel = ent["path"]
        p = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.exists(p):
            print("[MISS]  %s（文件不存在，跳过）" % rel)
            failed += 1
            continue
        cur_sha = sha256(p)
        if cur_sha == ent["sha256_out"]:
            print("[SKIP]  %s（已是改造版）" % rel)
            skipped += 1
            continue

        text = io.open(p, encoding="utf-8", errors="surrogateescape", newline="").read()
        matched_in = (cur_sha == ent["sha256_in"])
        new = text
        bad = None
        for i, r in enumerate(ent["rules"], 1):
            n = new.count(r["find"])
            if n != 1:
                bad = "第 %d 条规则命中 %d 次（期望 1 次）" % (i, n)
                break
            new = new.replace(r["find"], r["replace"], 1)
        if bad and matched_in:
            bad = None  # 输入就是参考版本，理论上不会走到这
        if bad:
            print("[FAIL]  %s -> %s" % (rel, bad))
            print("        你的版本与参考版本不同，需要人工对齐（见 docs/改造点清单.md）")
            failed += 1
            continue

        if not matched_in and not args.force:
            print("[WARN]  %s（输入 sha 与参考版本不一致；已按规则施加，请自行测试）" % rel)
        if args.check:
            print("[CHECK] %s（可以施加）" % rel)
        else:
            with io.open(p, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
                f.write(new)
            got = sha256(p)
            tag = "一致" if got == ent["sha256_out"] else "不一致（版本不同，请测试）"
            print("[OK]    %s -> %s" % (rel, tag))
        ok += 1

    print("\n完成：可施加/已施加 %d，跳过 %d，失败 %d" % (ok, skipped, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
