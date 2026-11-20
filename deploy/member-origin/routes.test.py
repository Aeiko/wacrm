"""Offline member route renderer contract."""
import unittest

from routes import build, PREFIX, GATEWAY


# Synthetic input. Do not use as an origin peer allowlist.
CIDRS = [f'{n}.0.0.0/24' for n in range(21, 30)] + ['2001:4860::/32']


class MemberRoutes(unittest.TestCase):
    def test_default_and_inert_do_not_route_to_crm(self):
        self.assertEqual(build(CIDRS), {'http': {}})
        http = build(CIDRS, 'inert')['http']
        self.assertFalse(http['services'])
        self.assertTrue(all(r['service'] == 'noop@internal' for r in http['routers'].values()))

    def test_exact_crm_routes_only(self):
        http = build(CIDRS, 'enabled')['http']
        rules = {
            'page': 'Path(`/settings/connect-whatsapp`) && (Method(`GET`) || Method(`HEAD`))',
            'inspect': 'Path(`/supervised-discovery`) && Method(`GET`)',
            'command': 'Path(`/supervised-discovery`) && Method(`POST`) && Header(`Origin`, `https://wacrm.sqkii.land`)',
        }
        self.assertEqual(set(http['routers']), {PREFIX + name for name in rules})
        peer = ' || '.join(f'ClientIP(`{cidr}`)' for cidr in CIDRS)
        for name, rule in rules.items():
            router = http['routers'][PREFIX + name]
            self.assertEqual(router['rule'], f'Host(`wacrm.sqkii.land`) && ({rule}) && ({peer})')
            self.assertEqual(router['middlewares'], [PREFIX + 'peer'])
            self.assertEqual(router['entryPoints'], ['websecure'])
            self.assertEqual(router['service'], GATEWAY)
            self.assertEqual(router['observability'], {'accessLogs': False, 'tracing': False})
        self.assertEqual(http['middlewares'][PREFIX + 'peer']['ipAllowList']['sourceRange'], CIDRS)
        self.assertEqual(http['services'][GATEWAY]['loadBalancer'], {
            'passHostHeader': True, 'servers': [{'url': 'http://172.29.124.8:8080'}],
        })
        with self.assertRaises(ValueError):
            build(CIDRS[:-1] + ['127.0.0.0/8'], 'enabled')


if __name__ == '__main__':
    unittest.main()
