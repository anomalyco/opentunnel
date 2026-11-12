"""Prepare crates.io's length-prefixed publish request in the read-only build job."""

import json
import os
import struct
import subprocess
from pathlib import Path

packages = json.loads(subprocess.check_output([
    'cargo', 'metadata', '--locked', '--no-deps', '--format-version', '1'
]))['packages']
out = Path(os.environ['RUNNER_TEMP']) / 'release'
for pkg in packages:
    name = pkg['name']
    if name not in ('opentunnel', 'opentunnel-cli'):
        continue
    metadata = {key: pkg[key] for key in (
        'name', 'authors', 'description', 'documentation', 'homepage', 'license',
        'license_file', 'repository', 'keywords', 'categories', 'features', 'rust_version'
    )}
    metadata['vers'] = pkg['version']
    metadata['deps'] = [{
        'name': dep['name'], 'version_req': dep['req'], 'features': dep['features'],
        'optional': dep['optional'], 'default_features': dep['uses_default_features'],
        'target': dep['target'], 'kind': dep['kind'] or 'normal',
        'explicit_name_in_toml': dep['rename'], 'registry': dep['registry'],
    } for dep in pkg['dependencies']]
    if pkg['readme']:
        metadata['readme_file'] = pkg['readme']
        metadata['readme'] = (Path(pkg['manifest_path']).parent / pkg['readme']).read_text()
    manifest = json.dumps(metadata).encode()
    archive = Path(f"target/package/{name}-{pkg['version']}.crate").read_bytes()
    (out / f'{name}.upload').write_bytes(struct.pack('<I', len(manifest)) + manifest
        + struct.pack('<I', len(archive)) + archive)
