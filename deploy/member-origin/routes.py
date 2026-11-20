#!/usr/bin/env python3
"""Render a standalone member router fragment to stdout; never install it."""
import argparse
import ipaddress
import json
import sys


SITE = 'wacrm.sqkii.land'
PREFIX = 'wacrm-member-origin-v1-'
GATEWAY = PREFIX + 'gateway'


def build(cidrs, mode='off'):
    if mode == 'off':
        return {'http': {}}
    if mode not in ('inert', 'enabled'):
        raise ValueError('unknown member routing mode')
    nets = [ipaddress.ip_network(cidr) for cidr in cidrs]
    if not (10 <= len(nets) <= 100 and len(set(nets)) == len(nets)
            and {net.version for net in nets} == {4, 6}
            and all(net.is_global for net in nets)):
        raise ValueError('expected current Cloudflare IPv4 and IPv6 ranges')
    peer = '(' + ' || '.join(f'ClientIP(`{net}`)' for net in nets) + ')'
    rules = {
        'page': 'Path(`/settings/connect-whatsapp`) && (Method(`GET`) || Method(`HEAD`))',
        'inspect': 'Path(`/supervised-discovery`) && Method(`GET`)',
        'command': f'Path(`/supervised-discovery`) && Method(`POST`) && Header(`Origin`, `https://{SITE}`)',
    }
    return {'http': {
        'routers': {PREFIX + name: {
            'rule': f'Host(`{SITE}`) && ({rule}) && {peer}',
            'entryPoints': ['websecure'], 'tls': {}, 'priority': 20500,
            'service': 'noop@internal' if mode == 'inert' else GATEWAY,
            'middlewares': [PREFIX + 'peer'],
            'observability': {'accessLogs': False, 'tracing': False},
        } for name, rule in rules.items()},
        'middlewares': {PREFIX + 'peer': {'ipAllowList': {'sourceRange': list(map(str, nets))}}},
        'services': {} if mode == 'inert' else {GATEWAY: {
            'loadBalancer': {'passHostHeader': True, 'servers': [{'url': 'http://172.29.124.8:8080'}]},
        }},
    }}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['off', 'inert', 'enabled'], nargs='?', default='off')
    mode = parser.parse_args().mode
    cidrs = []
    if mode != 'off':
        document = json.load(sys.stdin)
        if document.get('success') is not True:
            sys.exit('expected successful offline Cloudflare CIDR input')
        result = document['result']
        cidrs = result['ipv4_cidrs'] + result['ipv6_cidrs']
    print(json.dumps(build(cidrs, mode), indent=2))
