"""
Independent reference implementation of HandCash two-party key recovery.

Deliberately written from the specs with the Python standard library only — no
shared code, no shared dependencies with the TypeScript. Its output is baked
into scripts/verify.ts as fixtures, so if the two implementations ever disagree
about a composed key, the test suite fails.

Each share arrives as an extended private key (xprv), as the HandCash app
exports them. The composed key is:

    priv_key = (pk1 * pk2) % secp256k1.N

Usage:
    python3 scripts/reference/tss_reference.py
"""

import hashlib
import hmac
import json

# --- secp256k1 -------------------------------------------------------------

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        lam = (3 * a[0] * a[0]) * pow(2 * a[1], P - 2, P) % P
    else:
        lam = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P) % P
    x = (lam * lam - a[0] - b[0]) % P
    return (x, (lam * (a[0] - x) - a[1]) % P)


def point_mul(point, scalar):
    result = None
    addend = point
    while scalar:
        if scalar & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        scalar >>= 1
    return result


def compress(point):
    return (b"\x02" if point[1] % 2 == 0 else b"\x03") + point[0].to_bytes(32, "big")


# --- addresses -------------------------------------------------------------

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58check(payload):
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    data = payload + checksum
    number = int.from_bytes(data, "big")
    out = ""
    while number:
        number, rem = divmod(number, 58)
        out = B58[rem] + out
    return "1" * (len(data) - len(data.lstrip(b"\x00"))) + out


def hash160(data):
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def to_address(pubkey):
    return b58check(b"\x00" + hash160(pubkey))


def to_wif(secret):
    return b58check(b"\x80" + secret.to_bytes(32, "big") + b"\x01")


# --- BIP-32 --------------------------------------------------------------

XPRV_VERSION = bytes.fromhex("0488ade4")


def b58check_decode(text):
    number = 0
    for char in text:
        number = number * 58 + B58.index(char)
    leading = len(text) - len(text.lstrip("1"))
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    data = b"\x00" * leading + raw
    payload, checksum = data[:-4], data[-4:]
    assert hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] == checksum, "bad checksum"
    return payload


def parse_xprv(xprv):
    """BIP-32 serialization: version(4) depth(1) parent(4) index(4) chain(32) 0x00 key(32)."""
    payload = b58check_decode(xprv)
    assert len(payload) == 78, "extended keys are 78 bytes"
    assert payload[:4] == XPRV_VERSION, "not a mainnet extended private key"
    assert payload[45] == 0, "private key must be prefixed with 0x00"
    key = int.from_bytes(payload[46:78], "big")
    assert 0 < key < N, "private key out of range"
    return key, payload[13:45]


def master_from_seed(seed):
    digest = hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()
    return int.from_bytes(digest[:32], "big"), digest[32:]


def derive_child(key, chain_code, index):
    """Non-hardened CKDpriv. HandCash uses no hardened levels."""
    assert index < 0x80000000, "hardened derivation is not used by HandCash"
    data = compress(point_mul((GX, GY), key)) + index.to_bytes(4, "big")
    digest = hmac.new(chain_code, data, hashlib.sha512).digest()
    return (int.from_bytes(digest[:32], "big") + key) % N, digest[32:]


def derive_path(xprv, path):
    """Paths are relative to the exported key, whatever its depth."""
    key, chain_code = parse_xprv(xprv)
    for part in path.split("/")[1:]:
        key, chain_code = derive_child(key, chain_code, int(part))
    return key


# --- HandCash composition --------------------------------------------------


def compose(xprvs, path):
    """(d1 * d2) mod n, both shares derived at the same path."""
    first, second = (derive_path(xprv, path) for xprv in xprvs)
    return (first * second) % N


# The master keys of BIP-32 test vectors 1 and 2 — published constants, so the
# parser is checked against the spec as well as against the TypeScript.
SHARE_ONE = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"
SHARE_TWO = "xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U"
SEED_ONE = "000102030405060708090a0b0c0d0e0f"
SEED_TWO = (
    "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a2"
    "9f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542"
)

PATHS = ["m/0/0", "m/3/0", "m/4/12", "m/9/7", "m/0/2147483647"]


def main():
    # The parser must agree with the spec before anything else is trusted.
    assert parse_xprv(SHARE_ONE) == master_from_seed(bytes.fromhex(SEED_ONE))
    assert parse_xprv(SHARE_TWO) == master_from_seed(bytes.fromhex(SEED_TWO))

    fixtures = {"tss": {}}

    for path in PATHS:
        secret = compose([SHARE_ONE, SHARE_TWO], path)
        fixtures["tss"][path] = {
            "address": to_address(compress(point_mul((GX, GY), secret))),
            "wif": to_wif(secret),
        }

    # Order must not matter: multiplication mod n is commutative.
    fixtures["commutative"] = (
        compose([SHARE_ONE, SHARE_TWO], "m/3/0") == compose([SHARE_TWO, SHARE_ONE], "m/3/0")
    )
    # A composed key must not equal either share, or the split is a no-op.
    fixtures["composedDiffersFromShares"] = compose([SHARE_ONE, SHARE_TWO], "m/3/0") not in (
        derive_path(SHARE_ONE, "m/3/0"),
        derive_path(SHARE_TWO, "m/3/0"),
    )

    print(json.dumps(fixtures, indent=2))


if __name__ == "__main__":
    main()
