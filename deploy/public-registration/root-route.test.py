import re
import unittest

from routes import build


class PublicRoot(unittest.TestCase):
    def test_fixed_redirect_and_isolated_router(self):
        ranges = [f'{index}.0.0.0/24' for index in range(21, 30)] + ['2001:4860::/32']
        name = 'wacrm-public-root-v1'
        http = build(ranges, root_only=True)['http']
        self.assertEqual(set(http['routers']), {name})
        router = http['routers'][name]
        peers = '(' + ' || '.join(f'ClientIP(`{net}`)' for net in ranges) + ')'
        self.assertEqual(router['rule'], 'Host(`wacrm.sqkii.land`) && Path(`/`) && '
                         '(Method(`GET`) || Method(`HEAD`)) && ' + peers)
        self.assertEqual(router['service'], 'noop@internal')
        self.assertEqual(router['middlewares'], [name])
        redirect = http['middlewares'][name]['redirectRegex']
        for query in ('', '?next=https://other.test', '?', '?secret=a%0D%0Ab'):
            self.assertEqual(re.sub(redirect['regex'], redirect['replacement'],
                                    'https://wacrm.sqkii.land/' + query),
                             'https://wacrm.sqkii.land/login')
        for url in ('https://wacrm.sqkii.land/unknown', 'https://other.test/'):
            self.assertIsNone(re.search(redirect['regex'], url))
        self.assertNotIn(name, build(ranges)['http']['routers'])


if __name__ == '__main__':
    unittest.main()
