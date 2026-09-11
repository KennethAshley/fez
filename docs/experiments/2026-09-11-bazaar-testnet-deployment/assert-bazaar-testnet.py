#!/usr/bin/env python3
"""Fail before validator startup unless this deployment is testnet subnet 553."""
import json
import os
import sys

if os.environ.get('BAZAAR_CHAIN_NETWORK') != 'test' or os.environ.get('BAZAAR_NETUID') != '553':
    sys.exit('Refusing validator startup: BAZAAR_CHAIN_NETWORK=test and BAZAAR_NETUID=553 are required')

import bittensor as bt
sub = bt.subtensor(network='test')
try:
    if sub.network != 'test' or sub.endpoint != 'wss://test.finney.opentensor.ai:443':
        sys.exit('Refusing validator startup: SDK testnet endpoint mismatch')
    genesis = sub.query(('System', 'BlockHash'), [0])
    if genesis != '0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105':
        sys.exit('Refusing validator startup: testnet genesis mismatch')
    if not sub.query(('SubtensorModule', 'NetworksAdded'), [553]):
        sys.exit('Refusing validator startup: testnet subnet 553 is unavailable')
    print(json.dumps({'network': 'test', 'netuid': 553, 'endpoint': sub.endpoint, 'genesis': genesis, 'testnetVerified': True}))
finally:
    sub.close()
