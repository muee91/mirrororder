"""设备本地 BERT ONNX 句向量编码。

模型目录解析顺序（第一个同时含 model.onnx 与 tokenizer.json 的目录生效）：
1. ``MIRRORORDER_EMBEDDING_MODEL_DIR`` 环境变量；
2. ``<数据根>/models/embedding``；
3. ``<数据根>/models/vector-zh``。

编码全程在本机 CPU 执行，无网络请求；向量统一 L2 归一化。查询向量只经
显式 POST 计算面产生，GET 读路径不触碰本模块。
"""

from __future__ import annotations

import math
import os
from functools import lru_cache
from pathlib import Path

_MODEL_FILE = "model.onnx"
_TOKENIZER_FILE = "tokenizer.json"
_DIR_NAMES = ("embedding", "vector-zh")


def _data_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    from .device_runtime_settings import application_support_root

    return application_support_root()


def local_embedding_model_dir() -> Path | None:
    override = os.environ.get("MIRRORORDER_EMBEDDING_MODEL_DIR", "").strip()
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override).expanduser())
    root = _data_root() / "models"
    for name in _DIR_NAMES:
        candidates.append(root / name)
    for candidate in candidates:
        if (candidate / _MODEL_FILE).is_file() and (candidate / _TOKENIZER_FILE).is_file():
            return candidate
    return None


def local_embedding_available() -> bool:
    return local_embedding_model_dir() is not None


@lru_cache(maxsize=2)
def _embedding_resources(directory: Path, revision: str):
    import onnxruntime
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(directory / _TOKENIZER_FILE))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.no_padding()
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    session = onnxruntime.InferenceSession(str(directory / _MODEL_FILE), sess_options=options, providers=["CPUExecutionProvider"])
    output_names = {output.name for output in session.get_outputs()}
    output = "sentence_embedding" if "sentence_embedding" in output_names else "last_hidden_state"
    if output not in output_names:
        raise ValueError("本地向量模型缺少句向量或 BERT 隐状态输出")
    return session, tokenizer, output


class LocalEmbeddingEncoder:
    """与 SemanticEncoder 同接口的本地编码器；懒加载 ONNX 会话与分词器。"""

    class _ConfigView:
        enabled = True

        def __init__(self, name: str):
            self.model = name

        def public(self) -> dict:
            return {
                "enabled": True,
                "provider": "local-onnx",
                "model": self.model,
                "source": "device-local-embedding",
                "local": True,
            }

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.last_error = ""
        signatures = [(info.st_size, info.st_mtime_ns) for info in
                      ((self.directory / name).stat() for name in (_MODEL_FILE, _TOKENIZER_FILE))]
        self.revision = "-".join(f"{size:x}.{modified:x}" for size, modified in signatures)
        self.config = self._ConfigView(self.directory.name)

    @property
    def enabled(self) -> bool:
        return True

    @property
    def identity(self) -> str:
        return f"local-onnx:{self.directory.name}:{self.revision}"

    @staticmethod
    def _normalize(vector) -> list[float]:
        values = [float(value) for value in vector]
        magnitude = math.sqrt(sum(value * value for value in values))
        if not math.isfinite(magnitude) or magnitude <= 1e-12:
            raise ValueError("本地向量模型返回无效向量")
        return [value / magnitude for value in values]

    def encode(self, texts) -> list[list[float]] | None:
        clean = [str(text or "").strip()[:2000] for text in texts]
        if not clean:
            return []
        try:
            session, tokenizer, output_name = _embedding_resources(self.directory, self.revision)
            inputs = {item.name for item in session.get_inputs()}
            vectors: list[list[float]] = []
            for text in clean:
                encoding = tokenizer.encode(text)
                ids = [int(value) for value in encoding.ids]
                mask = [int(value) for value in encoding.attention_mask]
                types = [int(value) for value in encoding.type_ids]
                feed = {
                    "input_ids": [ids],
                    "attention_mask": [mask],
                    "token_type_ids": [types],
                }
                output = session.run([output_name], {name: value for name, value in feed.items() if name in inputs})[0]
                vector = output[0, 0] if output_name == "last_hidden_state" else output[0]
                vectors.append(self._normalize(vector))
            self.last_error = ""
            return vectors
        except Exception as error:
            self.last_error = str(error)[:300]
            return None

    def encode_one(self, text: str) -> list[float] | None:
        rows = self.encode([text])
        return rows[0] if rows else None
