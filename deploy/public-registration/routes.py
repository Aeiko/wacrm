#!/usr/bin/env python3
"""Render a separate Traefik registration route file; never touch the login file."""
import ipaddress
import json
import sys


def build(cidrs, gateway='http://172.29.124.8:8080', inert=False):
    nets = [ipaddress.ip_network(cidr) for cidr in cidrs]
    if not (10 <= len(nets) <= 100 and len(set(nets)) == len(nets)
            and {net.version for net in nets} == {4, 6}
            and all(net.is_global for net in nets)):
        raise ValueError('expected current Cloudflare IPv4 and IPv6 ranges')
    name = 'wacrm-registration-v1-'
    peer = '(' + ' || '.join(f'ClientIP(`{net}`)' for net in nets) + ')'
    crm = 'Host(`wacrm.sqkii.land`)'
    api = 'Host(`wacrm-api.sqkii.land`)'
    private = 'ClientIP(`172.29.124.9/32`)'
    routes, limits = {}, {}

    def route(key, rule, budget=0, source=peer):
        path = name + key
        r = {'rule': f'({rule}) && {source}', 'entryPoints': ['websecure'],
             'tls': {}, 'priority': 21100, 'service': 'noop@internal' if inert else name+'gateway',
             'observability': {'accessLogs': False, 'tracing': False}}
        if budget:
            r['middlewares'] = [path]
            limits[path] = {'rateLimit': {'average': budget, 'period': '1m', 'burst': budget,
                                         'sourceCriterion': {'requestHost': True}}}
        routes[path] = r

    route('form', crm + ' && (Path(`/signup`) || Path(`/signup/password`)) && (Method(`GET`) || Method(`HEAD`))')
    route('callback', crm + ' && Path(`/auth/callback`) && Method(`GET`)', 20)
    route('signup', api + ' && Path(`/auth/v1/signup`) && Method(`POST`)', 3)
    route('signup-preflight', api + ' && Path(`/auth/v1/signup`) && Method(`OPTIONS`)')
    route('first-password', api + ' && Path(`/auth/v1/user`) && Method(`PUT`)', 20)
    route('first-password-preflight', api + ' && Path(`/auth/v1/user`) && Method(`OPTIONS`) && Header(`Access-Control-Request-Method`, `PUT`)')
    route('verify-preview', api + ' && Path(`/auth/v1/verify`) && Method(`GET`)', 60)
    route('verify-submit', api + ' && Path(`/auth/v1/verify`) && Method(`POST`)', 20)
    route('exchange', api + ' && Path(`/auth/v1/token`) && Query(`grant_type`, `pkce`) && Method(`POST`)', 20, private)
    return {'http': {'routers': routes, 'middlewares': limits, 'services': {
        name+'gateway': {'loadBalancer': {'passHostHeader': True, 'servers': [{'url': gateway}]}}
    }}}


if __name__ == '__main__':
    if sys.argv[1:] not in (['inert'], ['live']):
        sys.exit('usage: routes.py [inert|live] < cloudflare-ips.json')
    result = json.load(sys.stdin)
    if result.get('success') is not True:
        sys.exit('Cloudflare CIDR fetch failed')
    ips = result['result']
    print(json.dumps(build(ips['ipv4_cidrs'] + ips['ipv6_cidrs'], inert=sys.argv[1] == 'inert'), indent=2))
