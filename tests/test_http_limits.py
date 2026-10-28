import unittest
from server.bridge import HttpRateLimiter


class PublicLimitsTest(unittest.TestCase):
    def test_ip_budget_cannot_be_bypassed_by_rotating_invalid_keys(self):
        now = [0.0]
        limit = HttpRateLimiter({'ipRate': 2, 'ipBurst': 2, 'keyRate': 1, 'keyBurst': 2}, lambda: now[0])
        self.assertTrue(limit.accept('client-a', 'invalid-1'))
        self.assertTrue(limit.accept('client-a', 'invalid-2'))
        self.assertFalse(limit.accept('client-a', 'invalid-3'))
        now[0] = .5
        self.assertTrue(limit.accept('client-a', 'invalid-4'))

    def test_key_budget_follows_key_across_addresses_without_storing_plaintext(self):
        limit = HttpRateLimiter({'ipBurst': 10, 'keyBurst': 1})
        self.assertTrue(limit.accept('a', 'Bearer dummy'))
        self.assertFalse(limit.accept('b', 'Bearer dummy'))
        self.assertNotIn('Bearer dummy', repr(limit.buckets))

    def test_bucket_memory_is_bounded(self):
        limit = HttpRateLimiter({'maxBuckets': 8})
        for i in range(20): limit.accept(str(i), str(i))
        self.assertLessEqual(len(limit.buckets), 8)
