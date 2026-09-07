#!/usr/bin/env python3
"""mechtool 语料检索器（自包含版，无外部依赖）。

语料全部内嵌于本 skill 的 data/ 目录（2261 页 / 约 645 万字），
本脚本可在任何机器上独立运行。

用法:
  python3 search_corpus.py topics                     # 列出 13 个主题组及页数/字数
  python3 search_corpus.py search "深沟球轴承"          # 标题+全文关键词检索
  python3 search_corpus.py search "6205" --topic 轴承与轴
  python3 search_corpus.py read <md文件名或URL路径>     # 读取整篇语料正文
  python3 search_corpus.py list <主题> [--top N]       # 列出主题下页面清单
  python3 search_corpus.py grep "许用应力" [--topic T] [--show]  # 正文逐行匹配
"""
import json, os, sys, re, argparse, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
MD = os.path.join(DATA, 'md')
GROUPS = json.load(open(os.path.join(DATA, 'topic_groups.json'), encoding='utf-8'))
MD_INDEX = json.load(open(os.path.join(DATA, 'md_index.json'), encoding='utf-8'))

# md_index: {"/path.html": {"file": "xxx.md", "title": "...", "chars": N}}
PATH2FILE = {p: v['file'] for p, v in MD_INDEX.items()}


def strip_noise(txt):
    txt = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', txt)      # 图片
    txt = re.sub(r'\[[^\]]*\]\(\)', '', txt)            # 空链接
    txt = re.sub(r'<!--.*?-->', '', txt, flags=re.S)     # 注释
    txt = re.sub(r'\[\s*TOP\s*\]', '', txt)
    txt = re.sub(r'\n{3,}', '\n\n', txt)
    return txt.strip()


def load_md(fname):
    fp = os.path.join(MD, fname)
    if os.path.exists(fp):
        return strip_noise(open(fp, encoding='utf-8').read()), True
    return None, False


def cmd_topics():
    total_p, total_c = 0, 0
    for k, v in GROUPS.items():
        chars = sum(f['chars'] for f in v)
        total_p += len(v); total_c += chars
        print(f"  {k}: {len(v)}页 {chars:,}字")
    print(f"\n  合计 {total_p} 页 / {total_c:,} 字")


def cmd_search(kw, topic=None, max_results=25):
    kw_l = kw.lower()
    title_hits, body_hits = [], []
    for t, files in GROUPS.items():
        if topic and t != topic:
            continue
        for f in files:
            if kw_l in f['title'].lower() or kw_l in f['path'].lower():
                title_hits.append((t, f))
    shown = title_hits[:max_results]
    print(f"== 标题匹配 {len(title_hits)} 个 ==")
    for t, f in shown:
        print(f"[{t}] {f['chars']:>7,} {f['title'][:66]}")
        print(f"         {f['path']}")
    if len(title_hits) > max_results:
        print(f"  ... 其余 {len(title_hits)-max_results} 个省略")
    # 正文匹配(仅当标题命中不足时补充)
    if len(title_hits) < 5:
        print(f"\n== 正文匹配(前{max_results}) ==")
        n = 0
        for t, files in GROUPS.items():
            if topic and t != topic:
                continue
            for f in sorted(files, key=lambda x: -x['chars']):
                txt, ok = load_md(f['file'])
                if not ok or not txt:
                    continue
                if kw_l in txt.lower():
                    i = txt.lower().find(kw_l)
                    snip = re.sub(r'\s+', ' ', txt[max(0, i-60):i+120])
                    print(f"[{t}] {f['title'][:56]}  ({f['path']})")
                    print(f"    …{snip}…")
                    n += 1
                    if n >= max_results:
                        break
            if n >= max_results:
                break


def cmd_read(target, max_chars=80000):
    """target: md 文件名 / 完整 URL 路径 / 部分路径"""
    fname = None
    if target in PATH2FILE:
        fname = PATH2FILE[target]
    elif target.endswith('.md') and os.path.exists(os.path.join(MD, target)):
        fname = target
    else:
        for p, v in MD_INDEX.items():
            if target in p:
                fname = v['file']
                print(f"匹配: {p}")
                break
    if not fname:
        # 尝试标题匹配
        for p, v in MD_INDEX.items():
            if target in v.get('title', ''):
                fname = v['file']
                print(f"匹配: {p}  ({v['title']})")
                break
    if not fname:
        sys.exit(f"未找到: {target}（可用 search 先查路径）")
    txt, ok = load_md(fname)
    if not ok:
        sys.exit(f"文件缺失: {fname}")
    print(txt[:max_chars])
    if len(txt) > max_chars:
        print(f"\n... (共 {len(txt):,} 字，已截断至 {max_chars:,})")


def cmd_list(topic, top=0):
    if topic not in GROUPS:
        print(f"未知主题: {topic}；可用: {' '.join(GROUPS)}")
        return
    files = sorted(GROUPS[topic], key=lambda f: -f['chars'])
    if top:
        files = files[:top]
    for f in files:
        print(f"  {f['chars']:>7,}  {f['title'][:70]}  ({f['path']})")


def cmd_grep(pattern, topic=None, show=False, max_results=30):
    rx = re.compile(pattern, re.I)
    n = 0
    for t, files in GROUPS.items():
        if topic and t != topic:
            continue
        for f in sorted(files, key=lambda x: -x['chars']):
            fp = os.path.join(MD, f['file'])
            if not os.path.exists(fp):
                continue
            for line in open(fp, encoding='utf-8'):
                if rx.search(line):
                    print(f"[{t}] {f['title'][:50]}: {line.strip()[:150]}")
                    n += 1
                    if n >= max_results:
                        return
                    break  # 每文件只报首行


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['topics', 'search', 'read', 'list', 'grep'])
    ap.add_argument('arg', nargs='?', default='')
    ap.add_argument('--topic', default='')
    ap.add_argument('--top', type=int, default=0)
    ap.add_argument('--show', action='store_true')
    args = ap.parse_args()
    if args.cmd == 'topics':
        cmd_topics()
    elif args.cmd == 'search':
        cmd_search(args.arg, args.topic or None)
    elif args.cmd == 'read':
        cmd_read(args.arg)
    elif args.cmd == 'list':
        cmd_list(args.arg, args.top)
    elif args.cmd == 'grep':
        cmd_grep(args.arg, args.topic or None, args.show)


if __name__ == '__main__':
    main()
