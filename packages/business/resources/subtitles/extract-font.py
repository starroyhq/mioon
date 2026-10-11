#!/usr/bin/env python3
"""Reproduce the bundled single SC face from an already installed local TTC.
No network access or package installation. Run with FontTools 4.57.0.
Usage: /usr/bin/python3 extract-font.py /path/to/NotoSansCJK-Regular.ttc /tmp/font.otf
"""
import hashlib
import sys
import fontTools
from fontTools.ttLib import TTFont
SOURCE_SHA = 'b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a'
RESULT_SHA = '7b13c45bba411924f99c1ee26e1a5ee1ea7fc768503a4d03987d587e16a72e99'
source, output = sys.argv[1:]
assert fontTools.__version__ == '4.57.0', 'Use the documented extraction tool version'
with open(source, 'rb') as stream:
    assert hashlib.sha256(stream.read()).hexdigest() == SOURCE_SHA
font = TTFont(source, fontNumber=2, recalcTimestamp=False)
cmap = font.getBestCmap()
allowed = list(range(0x20, 0x7f)) + list(range(0x4e00, 0x9ff0)) + [ord(c) for c in '，。！？；：、（）【】《》〈〉“”‘’—…·￥％～']
assert all(c in cmap and cmap[c] != '.notdef' for c in allowed)
font.save(output, reorderTables=False)
with open(output, 'rb') as stream:
    result = stream.read()
assert len(result) == 16437296 and hashlib.sha256(result).hexdigest() == RESULT_SHA
print(RESULT_SHA, len(result))
