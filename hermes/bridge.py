"""Publish a small, secret-free Hermes runtime state for the Beast widget.

Hermes itself is deliberately imported only inside the two integration
helpers.  Keeping import-time dependencies to the Python standard library
makes this package testable without a Hermes installation.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Optional
from urllib.parse import urlsplit


PLUGIN_NAME = "beast-telemetry"
SCHEMA_VERSION = 1
DEFAULT_LABEL = "Beast"
DEFAULT_STATS_PATHS = ("stats", "../metrics")
DEFAULT_INTERVAL_MS = 2_000
DEFAULT_REQUEST_TIMEOUT_MS = 1_500
DEFAULT_WINDOW_MS = 6_000

_PROCESS_LOCK = threading.RLock()


def _updated_at() -> int:
    """Return a JavaScript-compatible Unix epoch timestamp in milliseconds."""

    return int(time.time() * 1_000)


def _string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _positive_integer(value: Any, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return default
    return value


def _http_url(value: Any) -> Optional[str]:
    """Return a safe absolute HTTP(S) URL, or ``None``.

    Userinfo is rejected so a credential embedded in a URL can never reach
    the runtime file.  Queries are allowed because a metrics endpoint may
    legitimately use them and ``stats_url`` is explicitly non-secret config.
    """

    value = _string(value)
    if value is None:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"}:
            return None
        if not parsed.hostname or parsed.username is not None or parsed.password is not None:
            return None
        # Accessing port also rejects invalid values such as ":not-a-port".
        parsed.port
    except (TypeError, ValueError):
        return None
    return value


def _stats_paths(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or not value:
        return DEFAULT_STATS_PATHS
    result = []
    for item in value:
        item = _string(item)
        if item is None:
            return DEFAULT_STATS_PATHS
        result.append(item)
    return tuple(result)


def _load_hermes_config() -> Mapping[str, Any]:
    """Load Hermes non-secret config without making Hermes an import dependency."""

    try:
        from hermes_cli.config import load_config  # type: ignore[import-not-found]

        config = load_config()
    except Exception:
        return {}
    return config if isinstance(config, Mapping) else {}


def _hermes_home() -> Path:
    """Resolve the active profile home, falling back only when the API is absent."""

    try:
        from hermes_constants import get_hermes_home  # type: ignore[import-not-found]

        resolved = get_hermes_home()
        if resolved is not None:
            return Path(resolved).expanduser()
    except Exception:
        pass

    configured = os.environ.get("HERMES_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def runtime_path() -> Path:
    """Return the profile-scoped state path consumed by the widget."""

    return _hermes_home() / "plugin-data" / PLUGIN_NAME / "runtime.json"


def _plugin_entry(config: Mapping[str, Any]) -> Mapping[str, Any]:
    plugins = config.get("plugins")
    if not isinstance(plugins, Mapping):
        return {}
    entries = plugins.get("entries")
    if not isinstance(entries, Mapping):
        return {}
    entry = entries.get(PLUGIN_NAME)
    return entry if isinstance(entry, Mapping) else {}


def _settings(config: Mapping[str, Any]) -> dict[str, Any]:
    entry = _plugin_entry(config)
    return {
        "statsURL": _http_url(entry.get("stats_url")),
        "statsPaths": list(_stats_paths(entry.get("stats_paths"))),
        "label": _string(entry.get("label")) or DEFAULT_LABEL,
        "intervalMs": _positive_integer(entry.get("interval_ms"), DEFAULT_INTERVAL_MS),
        "requestTimeoutMs": _positive_integer(
            entry.get("request_timeout_ms"), DEFAULT_REQUEST_TIMEOUT_MS
        ),
        "windowMs": _positive_integer(entry.get("window_ms"), DEFAULT_WINDOW_MS),
    }


def load_settings() -> dict[str, Any]:
    """Return normalized, non-secret plugin settings (primarily for diagnostics)."""

    return _settings(_load_hermes_config())


def _configured_model(config: Mapping[str, Any]) -> dict[str, Optional[str]]:
    raw = config.get("model")
    if not isinstance(raw, Mapping):
        return {"model": None, "provider": None, "baseURL": None}
    return {
        "model": _string(raw.get("default")) or _string(raw.get("model")),
        "provider": _string(raw.get("provider")),
        "baseURL": _http_url(raw.get("base_url")),
    }


def _auto_active(provider: Optional[str], base_url: Optional[str]) -> bool:
    return bool(
        provider
        and provider.casefold() in {"custom", "vllm"}
        and _http_url(base_url) is not None
    )


def _state(
    *,
    settings: Mapping[str, Any],
    source: str,
    session_id: Any,
    model: Any,
    provider: Any,
    base_url: Any,
) -> dict[str, Any]:
    stats_url = settings.get("statsURL")
    clean_base_url = _http_url(base_url)
    if stats_url is not None:
        source = "override"
        active = True
    else:
        active = _auto_active(_string(provider), clean_base_url)

    # This explicit allowlist is the privacy boundary.  Hook kwargs, request
    # objects, headers, prompts, responses, and credentials are never merged.
    return {
        "schemaVersion": SCHEMA_VERSION,
        "active": active,
        "source": source,
        "sessionId": _string(session_id) or "",
        "model": _string(model) or "",
        "provider": _string(provider) or "",
        "baseURL": clean_base_url or "",
        "statsURL": stats_url,
        "statsPaths": list(settings["statsPaths"]),
        "label": settings["label"],
        "intervalMs": settings["intervalMs"],
        "requestTimeoutMs": settings["requestTimeoutMs"],
        "windowMs": settings["windowMs"],
        "updatedAt": _updated_at(),
    }


def _prepare_directory(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)


@contextmanager
def _locked(directory: Path) -> Iterator[None]:
    """Serialize thread and, where supported, process access to runtime state."""

    with _PROCESS_LOCK:
        _prepare_directory(directory)
        lock_path = directory / ".runtime.lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            os.chmod(lock_path, 0o600)
            try:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_EX)
            except (ImportError, OSError):
                pass
            yield
        finally:
            try:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            os.close(descriptor)


def _read_unlocked(path: Path) -> Optional[dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_unlocked(path: Path, state: Mapping[str, Any]) -> None:
    """Durably replace *path* using a same-directory, uniquely named file."""

    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(state, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
        try:
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            pass
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def _publish(state: Mapping[str, Any]) -> None:
    path = runtime_path()
    with _locked(path.parent):
        _write_unlocked(path, state)


def _mutate(transform: Callable[[Optional[dict[str, Any]]], Optional[dict[str, Any]]]) -> None:
    path = runtime_path()
    with _locked(path.parent):
        current = _read_unlocked(path)
        replacement = transform(current)
        if replacement is not None and replacement != current:
            _write_unlocked(path, replacement)


def read_runtime_state() -> Optional[dict[str, Any]]:
    """Read a consistent state snapshot, returning ``None`` for missing/corrupt data."""

    path = runtime_path()
    try:
        with _locked(path.parent):
            return _read_unlocked(path)
    except OSError:
        return None


def on_session_start(
    session_id: Optional[str] = None,
    model: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """Seed state from the selected Hermes model before its first request."""

    del kwargs
    try:
        config = _load_hermes_config()
        configured = _configured_model(config)
        state = _state(
            settings=_settings(config),
            source="config",
            session_id=session_id,
            model=_string(model) or configured["model"],
            provider=configured["provider"],
            base_url=configured["baseURL"],
        )
        _publish(state)
    except Exception:
        # Hermes isolates hook failures too, but callbacks remain fail-safe when
        # invoked directly by tests or third-party plugin hosts.
        return


def pre_api_request(
    session_id: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    base_url: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """Publish the exact routing metadata for the latest provider attempt."""

    del kwargs
    try:
        config = _load_hermes_config()
        state = _state(
            settings=_settings(config),
            source="request",
            session_id=session_id,
            model=model,
            provider=provider,
            base_url=base_url,
        )
        _publish(state)
    except Exception:
        return


def _cleanup(
    session_id: Optional[str],
    *,
    replacement_session_id: Optional[str] = None,
) -> None:
    matching_id = _string(session_id)
    if matching_id is None:
        return

    def transform(current: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        if current is None or current.get("sessionId") != matching_id:
            return current
        result = dict(current)
        if current.get("source") == "override" and current.get("statsURL"):
            result["active"] = True
        else:
            result["active"] = False
        replacement = _string(replacement_session_id)
        if replacement is not None:
            result["sessionId"] = replacement
        result["updatedAt"] = _updated_at()
        return result

    _mutate(transform)


def on_session_finalize(session_id: Optional[str] = None, **kwargs: Any) -> None:
    """Deactivate only the state owned by the outgoing session."""

    del kwargs
    try:
        _cleanup(session_id)
    except Exception:
        return


def on_session_reset(
    session_id: Optional[str] = None,
    old_session_id: Optional[str] = None,
    new_session_id: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """Handle both the compact and gateway reset callback shapes."""

    del kwargs
    try:
        outgoing = old_session_id if _string(old_session_id) is not None else session_id
        replacement = new_session_id
        if old_session_id is not None and replacement is None:
            replacement = session_id
        _cleanup(outgoing, replacement_session_id=replacement)
    except Exception:
        return


def register(ctx: Any) -> None:
    """Register the four Hermes lifecycle hooks used by this bridge."""

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_api_request", pre_api_request)
    ctx.register_hook("on_session_finalize", on_session_finalize)
    ctx.register_hook("on_session_reset", on_session_reset)


__all__ = [
    "load_settings",
    "on_session_finalize",
    "on_session_reset",
    "on_session_start",
    "pre_api_request",
    "read_runtime_state",
    "register",
    "runtime_path",
]
