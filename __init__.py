"""Hermes plugin entry point for Beast telemetry."""

from .hermes.bridge import register

__all__ = ["register"]
