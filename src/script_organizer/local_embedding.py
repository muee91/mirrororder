"""内置本地句向量编码器（BERT 系 ONNX，输出 sentence_embedding）。

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
        self._session = None
        self._tokenizer = None
        self.config = self._ConfigView(self.directory.name)

    @property
    def enabled(self) -> bool:
        return True

    @property
    def identity(self) -> str:
        return f"local-onnx:{self.directory.name}"

    def _resources(self):
        if self._session is None or self._tokenizer is None:
            import onnxruntime
            from tokenizers import Tokenizer

            self._tokenizer = Tokenizer.from_file(str(self.directory / _TOKENIZER_FILE))
            self._tokenizer.enable_truncation(max_length=512)
            self._tokenizer.no_padding()
            self._session = onnxruntime.InferenceSession(
                str(self.directory / _MODEL_FILE),
                providers=["CPUExecutionProvider"],
            )
        return self._session, self._tokenizer

    @staticmethod
    def _normalize(vector) -> list[float]:
        values = [float(value) for value in vector]
        magnitude = math.sqrt(sum(value * value for value in values))
        if not math.isfinite(magnitude) or magnitude <= 1e-12:
            return values
        return [value / magnitude for value in values]

    def encode(self, texts) -> list[list[float]] | None:
        clean = [str(text or "").strip()[:2000] for text in texts]
        if not clean:
            return []
        try:
            session, tokenizer = self._resources()
            output_name = session.get_outputs()[0].name
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
                output = session.run([output_name], feed)[0][0]
                vectors.append(self._normalize(output))
            self.last_error = ""
            return vectors
        except Exception as error:
            self.last_error = str(error)[:300]
            return None

    def encode_one(self, text: str) -> list[float] | None:
        rows = self.encode([text])
        return rows[0] if rows else None
