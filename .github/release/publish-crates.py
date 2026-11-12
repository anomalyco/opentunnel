"""Publish the previously packaged crates without running Cargo or unpacking them."""

import hashlib
import json
import os
import struct
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

version = os.environ['VERSION']
root = Path(os.environ['RUNNER_TEMP']) / 'release'
headers = {'User-Agent': 'opentunnel-release (github.com/anomalyco/opentunnel)'}
for name in ('opentunnel', 'opentunnel-cli'):
    payload = (root / f'{name}.upload').read_bytes()
    length, = struct.unpack_from('<I', payload)
    metadata = json.loads(payload[4:4 + length])
    if (metadata['name'], metadata['vers']) != (name, version):
        raise ValueError(f'unexpected crate in {name}.upload')
    try:
        with urlopen(Request(f'https://crates.io/api/v1/crates/{name}/{version}', headers=headers)) as response:
            checksum = json.load(response)['version']['checksum']
        if hashlib.sha256(payload[8 + length:]).hexdigest() != checksum:
            raise ValueError(f'{name}@{version} already exists with different contents')
        continue
    except HTTPError as error:
        if error.code != 404:
            raise
    request = Request('https://crates.io/api/v1/crates/new', method='PUT', data=payload,
                      headers={**headers, 'Authorization': os.environ['CARGO_REGISTRY_TOKEN'],
                               'Content-Type': 'application/octet-stream'})
    with urlopen(request) as response:
        if json.load(response).get('errors'):
            raise RuntimeError(f'crates.io rejected {name}@{version}')
