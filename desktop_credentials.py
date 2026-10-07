import ctypes
import os
from ctypes import wintypes


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def transform(value, decrypt=False):
    if os.name != 'nt':
        raise ValueError('Saved credentials require Windows; use SOLSCAN_API_KEY elsewhere')
    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    function = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ValueError('Windows could not access the saved Solscan credential')
    ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree(target.data)


def load_key(directory):
    key = os.environ.get('SOLSCAN_API_KEY', '').strip()
    path = directory / 'solscan-key.dpapi'
    if key or not path.exists():
        return key
    try:
        return transform(path.read_bytes(), True).decode()
    except (ValueError, UnicodeError, OSError):
        return ''


def save_key(directory, key):
    path = directory / 'solscan-key.dpapi'
    if key:
        path.write_bytes(transform(key.encode()))
    else:
        path.unlink(missing_ok=True)
