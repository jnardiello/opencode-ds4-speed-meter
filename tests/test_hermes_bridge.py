from __future__ import annotations

import importlib
import json
import os
import stat
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class HermesBridgeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name) / "hermes-home"
        self.config = {}

        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.home
        config_module = types.ModuleType("hermes_cli.config")
        config_module.load_config = lambda: self.config
        cli_package = types.ModuleType("hermes_cli")
        cli_package.__path__ = []

        self.modules = patch.dict(
            sys.modules,
            {
                "hermes_constants": constants,
                "hermes_cli": cli_package,
                "hermes_cli.config": config_module,
            },
        )
        self.modules.start()
        from hermes import bridge

        self.bridge = importlib.reload(bridge)

    def tearDown(self) -> None:
        self.modules.stop()
        self.temporary.cleanup()

    def state(self):
        return json.loads(self.bridge.runtime_path().read_text(encoding="utf-8"))

    def test_defaults_and_config_precedence(self) -> None:
        self.assertEqual(
            self.bridge.load_settings(),
            {
                "statsURL": None,
                "statsPaths": ["stats", "../metrics"],
                "label": "Beast",
                "intervalMs": 2000,
                "requestTimeoutMs": 1500,
                "windowMs": 6000,
            },
        )
        self.config = {
            "plugins": {
                "entries": {
                    "beast-telemetry": {
                        "stats_url": "https://stats.example.test/metrics",
                        "stats_paths": ["one", "two"],
                        "label": "Local Beast",
                        "interval_ms": 3000,
                        "request_timeout_ms": 700,
                        "window_ms": 9000,
                    }
                }
            }
        }
        self.assertEqual(
            self.bridge.load_settings(),
            {
                "statsURL": "https://stats.example.test/metrics",
                "statsPaths": ["one", "two"],
                "label": "Local Beast",
                "intervalMs": 3000,
                "requestTimeoutMs": 700,
                "windowMs": 9000,
            },
        )

    def test_register_maps_all_hooks(self) -> None:
        calls = []
        context = types.SimpleNamespace(
            register_hook=lambda name, callback: calls.append((name, callback))
        )
        self.bridge.register(context)
        self.assertEqual(
            [name for name, _ in calls],
            [
                "on_session_start",
                "pre_api_request",
                "on_session_finalize",
                "on_session_reset",
            ],
        )
        self.assertEqual(
            [callback for _, callback in calls],
            [
                self.bridge.on_session_start,
                self.bridge.pre_api_request,
                self.bridge.on_session_finalize,
                self.bridge.on_session_reset,
            ],
        )

    def test_atomic_write_and_permissions(self) -> None:
        self.config = {
            "model": {
                "default": "deepseek-v4-flash",
                "provider": "custom",
                "base_url": "http://127.0.0.1:8000/v1",
            }
        }
        self.bridge.on_session_start(session_id="session-a", model="runtime-model")
        path = self.bridge.runtime_path()
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertFalse(list(path.parent.glob(f".{path.name}.*.tmp")))
        self.assertEqual(self.state()["source"], "config")
        self.assertTrue(self.state()["active"])

        threads = [
            threading.Thread(
                target=self.bridge.pre_api_request,
                kwargs={
                    "session_id": "session-a",
                    "model": f"model-{index}",
                    "provider": "custom",
                    "base_url": f"http://127.0.0.1:{8000 + index}/v1",
                },
            )
            for index in range(10)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.state()["schemaVersion"], 1)
        self.assertFalse(list(path.parent.glob(f".{path.name}.*.tmp")))

    def test_request_state_never_contains_sensitive_payloads(self) -> None:
        secret = "should-never-be-persisted"
        self.bridge.pre_api_request(
            session_id="session-a",
            model="deepseek-v4-flash",
            provider="vllm",
            base_url="https://inference.example.test/v1",
            api_key=secret,
            headers={"authorization": secret},
            request={"messages": [{"content": secret}]},
            user_message=secret,
            conversation_history=[secret],
            assistant_response=secret,
        )
        raw = self.bridge.runtime_path().read_text(encoding="utf-8")
        self.assertNotIn(secret, raw)
        self.assertEqual(
            set(json.loads(raw)),
            {
                "schemaVersion",
                "active",
                "source",
                "sessionId",
                "model",
                "provider",
                "baseURL",
                "statsURL",
                "statsPaths",
                "label",
                "intervalMs",
                "requestTimeoutMs",
                "windowMs",
                "updatedAt",
            },
        )

    def test_session_matching_and_last_request_wins(self) -> None:
        self.bridge.pre_api_request(
            session_id="new-session",
            model="latest-model",
            provider="custom",
            base_url="http://127.0.0.1:9000/v1",
        )
        self.bridge.on_session_finalize(session_id="old-session")
        self.assertTrue(self.state()["active"])
        self.assertEqual(self.state()["model"], "latest-model")

        self.bridge.on_session_finalize(session_id="new-session")
        self.assertFalse(self.state()["active"])
        self.assertEqual(self.state()["sessionId"], "new-session")

    def test_explicit_override_wins_and_survives_cleanup(self) -> None:
        self.config = {
            "plugins": {
                "entries": {
                    "beast-telemetry": {
                        "stats_url": "https://telemetry.example.test/metrics"
                    }
                }
            }
        }
        self.bridge.pre_api_request(
            session_id="session-a",
            model="remote-model",
            provider="openrouter",
            base_url="https://openrouter.ai/api/v1",
        )
        self.assertEqual(self.state()["source"], "override")
        self.assertTrue(self.state()["active"])
        self.bridge.on_session_finalize(session_id="session-a")
        self.assertTrue(self.state()["active"])

        self.bridge.pre_api_request(
            session_id="session-b",
            model="remote-model",
            provider="openrouter",
            base_url="https://openrouter.ai/api/v1",
        )
        self.bridge.on_session_reset(session_id="session-b")
        self.assertTrue(self.state()["active"])

    def test_malformed_config_is_fail_safe(self) -> None:
        malformed_values = [
            None,
            [],
            {"plugins": []},
            {"plugins": {"entries": []}},
            {
                "plugins": {
                    "entries": {
                        "beast-telemetry": {
                            "stats_url": "file:///tmp/stats",
                            "stats_paths": ["ok", None],
                            "label": [],
                            "interval_ms": True,
                            "request_timeout_ms": -1,
                            "window_ms": "6000",
                        }
                    }
                },
                "model": "not-a-mapping",
            },
        ]
        config_module = sys.modules["hermes_cli.config"]
        for value in malformed_values:
            with self.subTest(value=value):
                config_module.load_config = lambda value=value: value
                self.bridge.on_session_start(session_id="safe", model="model")
                state = self.state()
                self.assertFalse(state["active"])
                self.assertEqual(state["statsPaths"], ["stats", "../metrics"])
                self.assertEqual(state["label"], "Beast")

        config_module.load_config = lambda: (_ for _ in ()).throw(ValueError("bad yaml"))
        self.bridge.pre_api_request(
            session_id="safe",
            model="model",
            provider="custom",
            base_url="http://127.0.0.1:8000/v1",
        )
        self.assertTrue(self.state()["active"])

    def test_fallback_home_without_hermes_modules(self) -> None:
        with patch.dict(sys.modules, {"hermes_constants": None}):
            with patch.dict(os.environ, {"HERMES_HOME": str(self.home / "fallback")}):
                self.assertEqual(
                    self.bridge.runtime_path(),
                    self.home
                    / "fallback"
                    / "plugin-data"
                    / "beast-telemetry"
                    / "runtime.json",
                )


if __name__ == "__main__":
    unittest.main()
