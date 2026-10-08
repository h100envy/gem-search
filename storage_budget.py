import ctypes
import os
import shutil
import threading
from pathlib import Path


LIMIT = 10_000_000_000


class StorageBudget:
    def __init__(self, directory, limit=LIMIT):
        self.directory = Path(directory)
        self.reserve = self.directory / 'storage-reserve.bin'
        self.limit = limit
        self.lock = threading.Lock()

    def used(self):
        return sum(path.stat().st_size for path in self.directory.rglob('*') if path.is_file() and path != self.reserve)

    def allocated(self):
        if not self.reserve.exists():
            return 0
        if os.name != 'nt':
            return self.reserve.stat().st_blocks * 512
        high = ctypes.c_ulong()
        function = ctypes.WinDLL('kernel32', use_last_error=True).GetCompressedFileSizeW
        function.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        function.restype = ctypes.c_ulong
        low = function(str(self.reserve), ctypes.byref(high))
        if low == 0xffffffff and ctypes.get_last_error():
            raise ctypes.WinError(ctypes.get_last_error())
        return (high.value << 32) + low

    def maintain(self):
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            used = self.used()
            if used > self.limit:
                raise OSError('The 10 GB storage allocation is full')
            target = self.limit - used
            old = self.reserve.stat().st_size if self.reserve.exists() else 0
            if shutil.disk_usage(self.directory).free < max(0, target - old) + 100_000_000:
                raise OSError('Not enough free disk space to reserve 10 GB')
            with self.reserve.open('r+b' if self.reserve.exists() else 'w+b') as file:
                file.truncate(target)
            return self.snapshot()

    def snapshot(self):
        return {'limit': self.limit, 'used': self.used(), 'reserved': self.allocated(), 'directory': str(self.directory)}

    def require_space(self, incoming=0):
        if self.reserve.exists() and self.used() + incoming + 1_000_000 > self.limit:
            raise OSError('The 10 GB storage allocation is full; collection paused')
