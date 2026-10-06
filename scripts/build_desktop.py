import subprocess
import sys
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
environment = dict(os.environ)
environment['PATH'] = os.pathsep.join([str(Path(sys.executable).parent), sys.base_prefix, str(Path(os.environ['SystemRoot']) / 'System32')])
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--windowed', '--name', 'GemSearch-Desktop', '--distpath', 'dist/desktop', '--workpath', 'build/desktop', '--specpath', 'build', 'desktop.py'], cwd=root, env=environment, check=True)
