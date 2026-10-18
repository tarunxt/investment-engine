"""Pure fixed-name nft IPv4 set rendering; caller retains network authorization."""
from ipaddress import IPv4Address


def render_ipv4_set(name, values):
    if name not in ('tls4', 'acme4') or not isinstance(values, list):
        raise ValueError('set scope denied')
    if len(values) > 14 or any(not isinstance(v, str) for v in values):
        raise ValueError('set elements denied')
    addresses = [str(IPv4Address(v)) for v in values]
    if len(addresses) != len(set(addresses)):
        raise ValueError('duplicate set elements')
    elements = ' elements = { ' + ', '.join(addresses) + ' };' if addresses else ''
    return 'set ' + name + ' { type ipv4_addr;' + elements + ' }'
