"""Admit only the supplied subset's ASCII glyphs into a Unicode web-font cmap.

No new glyphs, font downloads or dependencies. Keeps original licensed tables;
changes cmap, offsets and checksums only. See the font asset manifest/license.
Specification: https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
"""
import argparse
import hashlib
from pathlib import Path
import struct


def checksum(data):
    padded=data+b'\0'*((-len(data))%4)
    return sum(struct.unpack('>'+str(len(padded)//4)+'I',padded))&0xffffffff


def normalize(data):
    if data[:4]!=b'\x00\x01\x00\x00' or len(data)>128000:
        raise ValueError('Bounded supplied TrueType subset required')
    count=struct.unpack_from('>H',data,4)[0];tables={}
    for i in range(count):
        tag,_sum,offset,length=struct.unpack_from('>4sIII',data,12+16*i)
        if offset+length>len(data):raise ValueError('Invalid table bound')
        tables[tag]=data[offset:offset+length]
    old=tables[b'cmap']
    if struct.unpack_from('>HHHH',old,0)!=(0,1,1,0):
        raise ValueError('Exact Macintosh-only source cmap required')
    offset=struct.unpack_from('>I',old,8)[0]
    fmt,length,language,first,total=struct.unpack_from('>5H',old,offset)
    if fmt!=6 or first!=0 or total!=128:raise ValueError('Exact supplied mapping required')
    glyphs=list(struct.unpack_from('>128H',old,offset+10))[32:127]
    if not all(0<glyph<struct.unpack_from('>H',tables[b'maxp'],4)[0] for glyph in glyphs):
        raise ValueError('All admitted ASCII glyphs must already exist')
    # Two segments: ASCII followed by the required missing-character sentinel.
    sub=struct.pack('>7H',4,32+2*len(glyphs),0,4,4,1,0)
    sub+=struct.pack('>9H',126,65535,0,32,65535,0,1,4,0)
    sub+=struct.pack('>95H',*glyphs)
    tables[b'cmap']=struct.pack('>HHHHIHHI',0,2,0,3,20,3,1,20)+sub
    head=bytearray(tables[b'head']);head[8:12]=b'\0'*4;tables[b'head']=bytes(head)
    result=bytearray(data[:12]+b'\0'*(16*count));directory=[];head_offset=None
    for tag,body in sorted(tables.items()):
        result.extend(b'\0'*((-len(result))%4));offset=len(result)
        directory.append(struct.pack('>4sIII',tag,checksum(body),offset,len(body)))
        if tag==b'head':head_offset=offset
        result.extend(body)
    result.extend(b'\0'*((-len(result))%4));result[12:12+16*count]=b''.join(directory)
    struct.pack_into('>I',result,head_offset+8,(0xB1B0AFBA-checksum(bytes(result)))&0xffffffff)
    assert checksum(bytes(result))==0xB1B0AFBA
    return bytes(result),hashlib.sha256(tables[b'glyf']).hexdigest()


if __name__=='__main__':
    parser=argparse.ArgumentParser(__doc__);parser.add_argument('source',type=Path);parser.add_argument('destination',type=Path);parser.add_argument('--expected-source-sha256',required=True);args=parser.parse_args()
    data=args.source.read_bytes()
    if hashlib.sha256(data).hexdigest()!=args.expected_source_sha256:raise SystemExit('Source fingerprint changed')
    if args.destination.exists() and args.destination.read_bytes()!=data:raise SystemExit('Destination already differs; preserve it before another conversion')
    output,glyph_hash=normalize(data);args.destination.write_bytes(output)
    print('Normalized ASCII cmap; unchanged glyph table:',glyph_hash)
