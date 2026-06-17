# SPDX-License-Identifier: Apache-2.0
"""GLM-5.2 IndexShare DSA monkey-patch for mlx-lm v0.31.3 (omlx pin).

GLM-5.2 (``mlx-community/GLM-5.2-mxfp4``) shares ``model_type ==
"glm_moe_dsa"`` with GLM-5.1, but uses **IndexShare DSA**: only 21 of
the 78 decoder layers ("full" layers, at indices
``[0,1,2,6,10,...,74]``) carry an indexer; the other 57 ("shared")
layers reuse the top-k selection computed by the preceding full layer.

The stock ``mlx_lm.models.glm_moe_dsa`` model class is a thin subclass
of DeepSeek V3.2 and instantiates ``Indexer`` on *every* layer, so a
strict weight load fails with "Missing 285 parameters" (57 shared
layers × 5 indexer params the checkpoint never ships).

This patch registers an IndexShare-aware ``glm_moe_dsa`` model module
into ``sys.modules`` (overriding the stock one) when the model config
declares ``indexer_types``. GLM-5.1 (no ``indexer_types``) is untouched.

The patch is gated on ``model_type == "glm_moe_dsa"`` **and** the
presence of ``indexer_types`` in ``config.json``; the dispatch lives in
``omlx/utils/model_loading.py::maybe_apply_pre_load_patches`` (injected
idempotently by ``pi-shared/bin/pi-omlx-repair`` after each omlx
reinstall).

Maintenance
-----------
Unlike the omlx-team-maintained ``deepseek_v4`` patch, this one has no
upstream PR to converge to. The source of truth lives in
``pi-shared/patches/glm_5_2/`` (committed, cross-machine); the repair
script re-copies it into the omlx venv's
``site-packages/omlx/patches/glm_5_2/`` and re-injects the dispatch
branch after every ``uv tool install --force omlx``. Once omlx/mlx-lm
ships IndexShare natively, delete this package + the dispatch branch in
a single removal.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_APPLIED = False


def _register_module(qualname: str, file_name: str, *, force: bool = True) -> None:
    """Load a local file as if it were ``qualname`` (e.g. mlx_lm.models.glm_moe_dsa).

    Sets ``__package__`` to ``mlx_lm.models`` so relative imports inside
    the loaded file (``from .deepseek_v32 import ...``,
    ``from .cache import KVCache``) resolve through the real mlx_lm
    package — *not* through omlx.

    ``force=True`` overwrites any existing ``sys.modules`` entry so the
    IndexShare-aware class wins over the stock ``glm_moe_dsa`` module
    that may already be cached from a prior import.
    """
    if qualname in sys.modules and not force:
        return

    here = Path(__file__).parent
    file_path = here / file_name
    spec = importlib.util.spec_from_file_location(qualname, str(file_path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not create spec for {qualname} from {file_path}")
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "mlx_lm.models"
    sys.modules[qualname] = module
    spec.loader.exec_module(module)
    logger.info("Registered %s from %s", qualname, file_path.name)


def apply_glm_5_2_patch() -> bool:
    """Apply the GLM-5.2 IndexShare patch to mlx-lm. Idempotent.

    Must run *before* ``mlx_lm.load()`` / ``mlx_lm.utils._get_classes``
    imports ``mlx_lm.models.glm_moe_dsa`` for a GLM-5.2 model.

    Returns ``True`` if the patch was freshly applied, ``False`` if
    already applied or mlx-lm is not importable.
    """
    global _APPLIED
    if _APPLIED:
        return False

    try:
        import mlx_lm  # noqa: F401
    except ImportError:
        logger.debug("mlx_lm not importable — glm_5_2 patch skipped")
        return False

    # Override the stock glm_moe_dsa module with the IndexShare-aware one.
    # force=True so a previously-imported stock module (e.g. from a
    # prior GLM-5.1 load in the same process) is replaced.
    _register_module("mlx_lm.models.glm_moe_dsa", "glm_5_2_model.py", force=True)

    _APPLIED = True
    logger.info("GLM-5.2 IndexShare patch applied")
    return True


def is_applied() -> bool:
    return _APPLIED


__all__ = ["apply_glm_5_2_patch", "is_applied"]
