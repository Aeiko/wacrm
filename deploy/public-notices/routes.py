"""Render an isolated Traefik fragment; does not install it."""
import argparse
import ipaddress
import json
import sys


def build(cidrs, address):
    nets = [ipaddress.ip_network(cidr) for cidr in cidrs]
    if not (10 <= len(nets) <= 100 and len(set(nets)) == len(nets)
            and {net.version for net in nets} == {4, 6}
            and all(net.is_global for net in nets)):
        raise ValueError('expected current Cloudflare IPv4 and IPv6 ranges')
    target = ipaddress.IPv4Address(address)
    if not any(target in ipaddress.IPv4Network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('expected a private backend IPv4 address')
    peers = ' || '.join(f'ClientIP(`{net}`)' for net in nets)
    return {'http': {
        'routers': {'wacrm-public-notices-v1': {
            'rule': 'Host(`wacrm.sqkii.land`) && (Path(`/privacy`) || Path(`/data-deletion`))'
                    f' && (Method(`GET`) || Method(`HEAD`)) && ({peers})',
            'entryPoints': ['websecure'], 'tls': {}, 'priority': 21100,
            'service': 'wacrm-public-notices-v1',
            'observability': {'accessLogs': False, 'tracing': False},
        }},
        'services': {'wacrm-public-notices-v1': {'loadBalancer': {
            'passHostHeader': True, 'servers': [{'url': f'http://{target}:8080'}],
        }}},
    }}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('private_address')
    args = parser.parse_args()
    document = json.load(sys.stdin)
    if document.get('success') is not True:
        sys.exit('Cloudflare CIDR fetch failed')
    ranges = document['result']
    print(json.dumps(build(ranges['ipv4_cidrs'] + ranges['ipv6_cidrs'], args.private_address), indent=2))
