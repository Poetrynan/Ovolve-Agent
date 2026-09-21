"""device_fingerprint.py - Anonymous device identity + capability reporting.

Named as a flat module rather than ``telemetry/device.py`` on purpose: the
existing ``telemetry.py`` is a flat module, so creating a ``telemetry/``
package would shadow it and break every ``from telemetry import ...`` in the
codebase (see AUDIT_REPORT.md §9).

Privacy stance:
  - the device id is a salted hash, not raw hardware identifiers
  - MAC addresses, serial numbers and usernames never leave this module
  - capability reporting is coarse (counts and rounded sizes), not exact specs
"""
from __future__ import annotations

import hashlib
import os
import platform
import shutil
import sys
import uuid
from typing import Optional

from result import Result

#: Salt keeps the derived id from being reversible to the raw node id.
_FINGERPRINT_SALT = b"ovolve-device-v1"


class DeviceFingerprint:
    """Derive a stable, anonymous device identifier and report capabilities."""

    def __init__(self, salt: bytes = _FINGERPRINT_SALT) -> None:
        self._salt = salt
        self._cached_id: Optional[str] = None

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------

    def device_id(self) -> str:
        """Return a stable anonymous device id (hex, 32 chars).

        Derived from the machine node id, platform and home directory, hashed
        with a fixed salt. Stable across restarts on the same machine/user, and
        not reversible into the raw identifiers.
        """
        if self._cached_id:
            return self._cached_id
        raw = "|".join([
            str(uuid.getnode()),
            platform.system(),
            platform.machine(),
            os.path.expanduser("~"),
        ]).encode("utf-8")
        self._cached_id = hashlib.sha256(self._salt + raw).hexdigest()[:32]
        return self._cached_id

    # ------------------------------------------------------------------
    # Capabilities
    # ------------------------------------------------------------------

    def platform_info(self) -> dict:
        """Report OS / Python versions (no hostname, no username)."""
        return {
            "os": platform.system(),
            "os_release": platform.release(),
            "arch": platform.machine(),
            "python": platform.python_version(),
            "python_impl": platform.python_implementation(),
            "is_64bit": sys.maxsize > 2 ** 32,
        }

    def cpu_info(self) -> dict:
        """Report coarse CPU capability."""
        return {
            "logical_cores": os.cpu_count() or 0,
            "processor_family": platform.processor() or "unknown",
        }

    def memory_info(self) -> dict:
        """Report total RAM in GiB, rounded. Empty dict when undetectable."""
        total = self._total_memory_bytes()
        if total is None:
            return {}
        return {"total_gib": round(total / (1024 ** 3), 1)}

    def disk_info(self, path: str = None) -> dict:
        """Report disk capacity for a path, rounded to GiB.

        Args:
            path: Path to inspect; defaults to the home directory.
        """
        target = path or os.path.expanduser("~")
        try:
            usage = shutil.disk_usage(target)
        except OSError:
            return {}
        return {
            "total_gib": round(usage.total / (1024 ** 3), 1),
            "free_gib": round(usage.free / (1024 ** 3), 1),
        }

    def accelerators(self) -> dict:
        """Detect which local inference accelerators are usable.

        Detection is import-based (no device enumeration) to stay cheap and
        avoid loading heavy runtimes during startup.
        """
        result = {"openvino": False, "onnxruntime": False, "paddleocr": False}
        for name in list(result):
            try:
                __import__(name)
                result[name] = True
            except Exception:
                result[name] = False
        return result

    # ------------------------------------------------------------------
    # Aggregate
    # ------------------------------------------------------------------

    def report(self) -> Result:
        """Build the full anonymous device report.

        Returns:
            Result with a dict containing ``device_id``, ``platform``, ``cpu``,
            ``memory``, ``disk`` and ``accelerators``.
        """
        try:
            payload = {
                "device_id": self.device_id(),
                "platform": self.platform_info(),
                "cpu": self.cpu_info(),
                "memory": self.memory_info(),
                "disk": self.disk_info(),
                "accelerators": self.accelerators(),
            }
        except Exception as exc:  # never break startup over telemetry
            return Result.failure(f"Device report failed: {exc}", code="ReportFailed")
        return Result.success(payload)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _total_memory_bytes() -> Optional[int]:
        """Best-effort total RAM detection with no third-party dependency."""
        try:
            import psutil  # type: ignore
            return int(psutil.virtual_memory().total)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        # POSIX
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            if pages > 0 and page_size > 0:
                return pages * page_size
        except (AttributeError, ValueError, OSError):
            pass  # fail-open: 可选增强，失败不影响主流程
        # Windows
        if platform.system() == "Windows":
            try:
                import ctypes

                class MemoryStatusEx(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                    ]

                stat = MemoryStatusEx()
                stat.dwLength = ctypes.sizeof(MemoryStatusEx)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                    return int(stat.ullTotalPhys)
            except Exception:
                return None
        return None


_fingerprint: Optional[DeviceFingerprint] = None


def get_device_fingerprint() -> DeviceFingerprint:
    """Get the global DeviceFingerprint singleton."""
    global _fingerprint
    if _fingerprint is None:
        _fingerprint = DeviceFingerprint()
    return _fingerprint
