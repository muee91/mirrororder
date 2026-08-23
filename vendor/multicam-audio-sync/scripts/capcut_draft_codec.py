#!/usr/bin/env python3
"""剪映/CapCut 官方草稿加密格式编解码（独立模块，无第三方依赖除 pycryptodome）。

来源：逆向自 JianYingvideo 项目（github.com/linghungegeg/JianYingvideo，
app/services/jianying/official_draft_codec.py），在本机剪映 11.3.0（Mac）
实测 24/24 个编辑过的草稿解码成功（2026-08-21）。

背景：剪映草稿未加载/未编辑时 draft_info.json 是明文 JSON；一旦剪映
打开并保存过，就变成"官方加密容器"——AES-GCM 加密的 JSON，密钥 32 字符
+ IV 16 字符（62 位字母数字表）以 4 字符为单位内嵌在容器文本的固定偏移。
本模块可解码（验证剪映处理后的草稿）和编码（生成加密草稿）。

解码后即可看到剪映真实写入的结构（如多机位主草稿的 materials.drafts
内嵌 draft、轨 segment 引用链），是"不靠猜、看证据"的核心工具。
"""
import base64
import json
from pathlib import Path

try:
    from Crypto.Cipher import AES
except Exception:  # pragma: no cover
    AES = None


OFFICIAL_DRAFT_CONTENT_EMBEDDED_KEY_OFFSETS = (0, 7, 20, 33, 40, 47, 59, 66)
OFFICIAL_DRAFT_CONTENT_EMBEDDED_IV_OFFSETS = (76, 89, 99, 127)
OFFICIAL_DRAFT_CONTENT_CRYPT_ALPHABET = (
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


def decode_official_encrypted_draft_content(path):
    """解码官方加密草稿容器 -> (dict, diagnostics)。"""
    if AES is None:
        raise ValueError("pycryptodome AES 不可用: pip install pycryptodome")
    container_text = Path(path).read_text(encoding="utf-8").strip()
    offsets = (*OFFICIAL_DRAFT_CONTENT_EMBEDDED_KEY_OFFSETS,
               *OFFICIAL_DRAFT_CONTENT_EMBEDDED_IV_OFFSETS)
    if len(container_text) < offsets[-1] + 4:
        raise ValueError("官方加密载荷太短")
    extracted_parts, body_parts, last_offset = [], [], 0
    for offset in offsets:
        extracted_parts.append(container_text[offset:offset + 4])
        if offset - last_offset > 4:
            body_parts.append(container_text[last_offset + 4:offset])
        last_offset = offset
    body_parts.append(container_text[last_offset + 4:])

    key_text = "".join(extracted_parts[:len(OFFICIAL_DRAFT_CONTENT_EMBEDDED_KEY_OFFSETS)])
    iv_text = "".join(extracted_parts[len(OFFICIAL_DRAFT_CONTENT_EMBEDDED_KEY_OFFSETS):])
    encrypted_bytes = base64.b64decode("".join(body_parts), validate=True)
    if len(encrypted_bytes) <= 16:
        raise ValueError("官方加密载荷 body 太短")
    cipher = AES.new(key_text.encode("utf-8"), AES.MODE_GCM,
                     nonce=iv_text.encode("utf-8"))
    plain_bytes = cipher.decrypt_and_verify(encrypted_bytes[:-16],
                                            encrypted_bytes[-16:])
    data = json.loads(plain_bytes.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("官方加密载荷解码后不是 JSON 对象")
    diagnostics = {
        "reader": "official_aesgcm",
        "container_length": len(container_text),
        "body_base64_length": sum(len(item) for item in body_parts),
        "plain_length": len(plain_bytes),
    }
    return data, diagnostics


def encode_official_encrypted_draft_content(data):
    """把 dict 编码成官方加密容器 -> (container_text, diagnostics)。"""
    if AES is None:
        raise ValueError("pycryptodome AES 不可用: pip install pycryptodome")
    import secrets
    plain_text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    key_text = "".join(secrets.choice(OFFICIAL_DRAFT_CONTENT_CRYPT_ALPHABET)
                       for _ in range(32))
    iv_text = "".join(secrets.choice(OFFICIAL_DRAFT_CONTENT_CRYPT_ALPHABET)
                      for _ in range(16))
    cipher = AES.new(key_text.encode("utf-8"), AES.MODE_GCM,
                     nonce=iv_text.encode("utf-8"))
    encrypted_bytes, auth_tag = cipher.encrypt_and_digest(
        plain_text.encode("utf-8"))
    body_text = base64.b64encode(encrypted_bytes + auth_tag).decode("ascii")

    offsets = (*OFFICIAL_DRAFT_CONTENT_EMBEDDED_KEY_OFFSETS,
               *OFFICIAL_DRAFT_CONTENT_EMBEDDED_IV_OFFSETS)
    embedded_chunks = [key_text[index * 4:(index + 1) * 4] for index in range(8)]
    embedded_chunks.extend(iv_text[index * 4:(index + 1) * 4]
                           for index in range(4))
    container_parts = [embedded_chunks[0]]
    body_cursor, previous_offset = 0, offsets[0]
    for offset, chunk in zip(offsets[1:], embedded_chunks[1:]):
        slice_len = offset - previous_offset - 4
        if slice_len < 0:
            raise ValueError("官方加密载荷偏移无效")
        container_parts.append(body_text[body_cursor:body_cursor + slice_len])
        container_parts.append(chunk)
        body_cursor += slice_len
        previous_offset = offset
    container_parts.append(body_text[body_cursor:])
    return "".join(container_parts), {
        "writer": "official_aesgcm",
        "container_length": len("".join(container_parts)),
    }


def load_draft_payload(path):
    """加载草稿 JSON：明文直接解析，官方加密自动解码。"""
    text = Path(path).read_text(encoding="utf-8").lstrip("\ufeff\x00\r\n\t ")
    if text[:1] == "{":
        return json.loads(text), {"reader": "plain"}
    return decode_official_encrypted_draft_content(path)


def summarize_multicam(draft):
    """输出多机位识别状态摘要（解码后草稿用）。"""
    lines = []
    m = draft.get("materials", {})
    lines.append(f"tracks={len(draft.get('tracks', []))} "
                 f"videos={len(m.get('videos', []))} "
                 f"drafts={len(m.get('drafts', []))}")
    for i, t in enumerate(draft.get("tracks", [])):
        for s in t.get("segments", []):
            refs = s.get("extra_material_refs") or []
            is_mc = bool(s.get("hdr_settings")) and len(refs) == 7
            lines.append(f"track[{i}] material_id={str(s.get('material_id'))[:8]} "
                         f"refs={len(refs)} hdr={s.get('hdr_settings')} "
                         f"{'<多机位轨>' if is_mc else ''}")
    for dr in m.get("drafts", []):
        emb = dr.get("draft")
        lines.append(f"draft {str(dr.get('id'))[:8]} embedded={'YES' if emb else 'NO'} "
                     f"emb_tracks={len(emb.get('tracks', [])) if emb else 0}")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("用法: python3 capcut_draft_codec.py <draft_info.json 路径>")
        sys.exit(1)
    data, diag = load_draft_payload(sys.argv[1])
    print(f"reader: {diag.get('reader')}")
    print(f"id: {data.get('id')}  fps: {data.get('fps')}  "
          f"duration: {data.get('duration')}")
    print(summarize_multicam(data))
