"""Local, deterministic paint study for the two registered knight layers.

Requires Pillow, NumPy and aggdraw. Run from the repository root:
    python3 layers/attire/knight/source/paint.py

The shapes and brush directions are authored on template/bust.svg's master grid.
This renders pigment, metal reflections and garment self-shadow only; it does
not apply the collection's varnish, craquelure or frame-shadow finish.
"""
from pathlib import Path
import math
import re
import json
import xml.etree.ElementTree as ET
import numpy as np
import aggdraw
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'layers/attire/knight'
W, H = 2048, 2560
RNG = np.random.default_rng(183743)
P = {
    'umber': '#32251F', 'forest': '#253E32', 'moss': '#657044',
    'oxblood': '#682F38', 'ochre': '#B48A47', 'gold': '#C9A45A',
    'bone': '#D7C7A3', 'silver': '#A7A9A4', 'steel': '#5E625F',
    'night': '#14100D', 'vert': '#17281F',
}


def rgb(s):
    s = P.get(s, s).lstrip('#')
    return np.array([int(s[i:i+2], 16) for i in (0, 2, 4)], dtype=np.float32)


def mix(a, b, t):
    return rgb(a) * (1-t) + rgb(b) * t


def col(v):
    if isinstance(v, str):
        v = rgb(v)
    return tuple(np.clip(np.rint(v), 1, 254).astype(np.uint8).tolist())


def path(d, dx=0, dy=0):
    tokens = re.findall(r'[MLCQZmlcqz]|-?\d+(?:\.\d+)?', d)
    p = aggdraw.Path()
    i = 0
    x = y = 0
    while i < len(tokens):
        op = tokens[i]
        i += 1
        count = {'M': 2, 'L': 2, 'C': 6, 'Q': 4, 'Z': 0}[op]
        vals = [float(t) for t in tokens[i:i+count]]
        i += count
        if op == 'M':
            x, y = vals
            p.moveto(x+dx, y+dy)
        elif op == 'L':
            x, y = vals
            p.lineto(x+dx, y+dy)
        elif op == 'C':
            p.curveto(*(v+(dx if j % 2 == 0 else dy) for j, v in enumerate(vals)))
            x, y = vals[-2:]
        elif op == 'Q':
            qx, qy, ex, ey = vals
            p.curveto(x+(qx-x)*2/3+dx, y+(qy-y)*2/3+dy,
                      ex+(qx-ex)*2/3+dx, ey+(qy-ey)*2/3+dy, ex+dx, ey+dy)
            x, y = ex, ey
        elif op == 'Z':
            p.close()
    return p


def mask(d):
    im = Image.new('L', (W, H))
    ctx = aggdraw.Draw(im)
    ctx.path(path(d), aggdraw.Brush(255))
    ctx.flush()
    return im


def grain(w, h, cell):
    tiny = RNG.uniform(-1, 1, (max(2, h//cell+2), max(2, w//cell+2))).astype('float32')
    return np.asarray(Image.fromarray(tiny).resize((w, h), Image.Resampling.BICUBIC))


SILVER = [mix('bone', 'silver', .48), rgb('silver'),
          rgb('steel'), mix('steel', 'forest', .55), mix('umber', 'vert', .45)]
CLOTH = [mix('oxblood', 'bone', .18), rgb('oxblood'),
         mix('oxblood', 'umber', .48), mix('umber', 'vert', .3)]
LEATHER = [mix('ochre', 'bone', .15), mix('ochre', 'umber', .35),
           rgb('umber'), mix('umber', 'night', .4)]


def color_field(t, material):
    colors = {'silver': SILVER, 'cloth': CLOTH, 'leather': LEATHER,
              'mail': [rgb('silver'), rgb('steel'), mix('forest', 'umber', .4), rgb('night')]}[material]
    pos = np.clip(t, 0, 1) * (len(colors)-1)
    lo = np.minimum(pos.astype('int32'), len(colors)-2)
    a = (pos-lo)[..., None]
    return np.asarray(colors)[lo]*(1-a) + np.asarray(colors)[lo+1]*a


class Painter:
    def __init__(self):
        self.im = Image.new('RGBA', (W, H))
        self.masks = {}

    def surface(self, name, d, material='silver', bias=0, flow='vertical', model=None, density=1):
        m = mask(d)
        self.masks[name] = m
        box = m.getbbox()
        x0, y0, x1, y1 = box
        w, h = x1-x0, y1-y0
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        u, v = (xx-x0)/w, (yy-y0)/h
        t = .17 + .38*u + .27*v + bias
        if model is not None:
            t = model(xx, yy, u, v) + bias
        t += grain(w, h, 85)*.035 + grain(w, h, 19)*.025
        base = color_field(t, material)
        base += grain(w, h, 5)[..., None]*1.7
        original = np.clip(base, 1, 254).astype('uint8')
        paint = Image.fromarray(original)
        draw = ImageDraw.Draw(paint)
        ma = np.asarray(m.crop(box))
        area = np.count_nonzero(ma > 240)

        # Unequal overlapping loaded-brush marks; bristles follow each plate.
        for scale, spacing, strength in [(1.8, 210, 6.5), (1, 56, 7.0), (.55, 30, 5.5)]:
            for _ in range(int(area/spacing*density)):
                x, y = int(RNG.integers(w)), int(RNG.integers(h))
                if ma[y, x] < 245:
                    continue
                X, Y = x+x0, y+y0
                if callable(flow):
                    angle = flow(X, Y)
                elif flow == 'horizontal':
                    angle = -.08 + .18 * (Y-y0)/h
                elif flow == 'arc':
                    angle = math.atan2((X-(x0+w*.46))*.7, -(Y-(y0+h*1.65)))
                elif flow == 'diagonal':
                    angle = 1.0 + .1*math.sin(Y*.01)
                else:
                    angle = 1.46 + .13*math.sin((X-x0)/w*math.pi)
                angle += RNG.normal(0, .13)
                length = RNG.uniform(9, 29)*scale
                width = RNG.uniform(2, 6)*scale
                if material == 'cloth':
                    length *= 1.4
                    width *= 1.7
                vec = (math.cos(angle), math.sin(angle))
                end = (x+vec[0]*length, y+vec[1]*length)
                shade = RNG.normal(0, strength)
                c = col(original[y, x].astype(float)+shade)
                bend = RNG.normal(0, length*.08)
                mid = (x+vec[0]*length*.5-vec[1]*bend,
                       y+vec[1]*length*.5+vec[0]*bend)
                draw.line([(x, y), mid, end], fill=c, width=max(1, int(width)))
                # Thin tips and dry hairs keep dabs from reading as rectangles.
                tip = (end[0]+vec[0]*length*.13, end[1]+vec[1]*length*.13)
                draw.line([end, tip], fill=c, width=max(1, int(width*.4)))
                # Broken bristle ridge, not a uniform stroke outline.
                if RNG.random() < .68:
                    off = width*.25
                    p0 = (x-vec[1]*off, y+vec[0]*off)
                    p1 = (p0[0]+vec[0]*length*.7, p0[1]+vec[1]*length*.7)
                    draw.line([p0, p1], fill=col(np.array(c)+RNG.uniform(2, 9)), width=1)
        rgba = paint.filter(ImageFilter.GaussianBlur(.28)).convert('RGBA')
        rgba.putalpha(m.crop(box))
        self.im.alpha_composite(rgba, (x0, y0))

    def line(self, d, color, width=3, opacity=255, clip=None, offset=(0, 0), soft=0):
        # aggdraw blends against its destination. Draw coverage separately to
        # avoid premultiplied/dark RGB on transparent antialiased stroke edges.
        coverage = Image.new('L', (W, H))
        c = aggdraw.Draw(coverage)
        c.path(path(d, *offset), None, aggdraw.Pen(255, width, opacity))
        c.flush()
        box = coverage.getbbox()
        if box:
            al = np.asarray(coverage.crop(box)).astype('float32')
            bristle = .83 + .14*grain(box[2]-box[0], box[3]-box[1], 13)
            coverage.paste(Image.fromarray(np.clip(al*bristle, 0, 255).astype('uint8')), box)
        if soft:
            coverage = coverage.filter(ImageFilter.GaussianBlur(soft))
        if clip is not None:
            alpha = np.asarray(coverage, dtype=np.uint16)
            alpha = (alpha * np.asarray(self.masks[clip], dtype=np.uint16) // 255).astype('uint8')
            coverage = Image.fromarray(alpha)
        lay = Image.new('RGBA', (W, H), col(color)+(255,))
        lay.putalpha(coverage)
        self.im = Image.alpha_composite(self.im, lay)

    def rim(self, d, width=7, bright=.75):
        self.line(d, mix('umber', 'forest', .3), width+4, 205)
        self.line(d, mix('steel', 'silver', .30), width, 255)
        # Light catches the up-left half of the rolled edge.
        self.line(d, mix('silver', 'bone', .37), max(1.5, width*.30),
                  int(255*bright), offset=(-1.8, -2), soft=.25)

    def rivet(self, x, y, r=5, warm=False):
        d = ImageDraw.Draw(self.im)
        d.ellipse((x-r-1, y-r, x+r+2, y+r+3), fill=col(mix('umber', 'forest', .4)))
        d.ellipse((x-r, y-r, x+r, y+r), fill=col(mix('steel', 'ochre', .35) if warm else rgb('steel')))
        d.arc((x-r, y-r, x+r, y+r), 180, 290,
              fill=col(mix('bone', 'silver', .35)), width=max(1, int(r*.4)))
        d.ellipse((x-r*.48, y-r*.65, x, y-r*.05), fill=col(mix('bone', 'ochre', .15)))

    def mail(self, name):
        region = self.masks[name]
        box = region.getbbox()
        lay = Image.new('RGBA', (W, H))
        d = ImageDraw.Draw(lay)
        for j, y in enumerate(range(box[1]+3, box[3], 13)):
            for x in range(box[0]+(j%2)*7, box[2], 15):
                if region.getpixel((x, y)) < 250:
                    continue
                v = RNG.uniform(.2, .8)
                d.arc((x-5, y-4, x+5, y+6), 15, 330, fill=col(mix('umber', 'forest', .35)), width=3)
                d.arc((x-5, y-4, x+4, y+5), 170, 285, fill=col(mix('steel', 'silver', v*.55)), width=2)
        lay.putalpha(Image.fromarray(np.minimum(np.asarray(lay.getchannel('A')), np.asarray(region))))
        self.im = Image.alpha_composite(self.im, lay)

    def save(self, name):
        arr = np.asarray(self.im).copy()
        arr[:144] = 0
        arr[2368:] = 0
        arr[:, :144] = 0
        arr[:, 1904:] = 0
        arr[arr[..., 3] == 0] = 0
        self.im = Image.fromarray(arr)
        # Ordinary, straight RGBA8 PNG, explicitly tagged sRGB; no clock metadata.
        from PIL.PngImagePlugin import PngInfo
        info = PngInfo()
        info.add(b'sRGB', b'\x00')
        self.im.save(OUT/name, pnginfo=info, compress_level=9)


def breast_model(x, y, u, v):
    ridge = 933+(y-1750)*.135
    t = .37 + .13*u + .22*v
    t -= .35*np.exp(-((x-ridge+22)/37)**2)
    t += .25*np.exp(-((x-ridge-30)/32)**2)
    t -= .22*np.exp(-((x-(660+.10*(y-1750)))/155)**2)
    t += .16*np.exp(-((x-1295)/115)**2)
    t += .035*np.sin(v*9+u*5)
    return t


def paint_armour():
    a = Painter()
    # The padded arming coat covers the foundation's wide amphibian shoulders.
    body = ('M678 1574 C711 1564 746 1565 771 1577 C878 1622 1100 1632 1195 1571 '
            'C1318 1585 1468 1647 1575 1699 C1734 1723 1829 1844 1871 1977 '
            'C1902 2087 1879 2200 1870 2368 L169 2368 C147 2269 144 2160 146 2061 '
            'C149 1925 212 1792 344 1748 C440 1700 517 1610 678 1574 Z')
    a.surface('arming-coat', body, 'cloth', bias=.09, flow='diagonal', density=1.4)
    # Oxblood pads, broken quilt seams disappearing beneath the plate.
    for x in range(190, 1800, 55):
        a.line(f'M{x} 1770 C{x+85} 1930 {x+120} 2160 {x+176} 2367',
               mix('oxblood', 'umber', .7), 3, 110, clip='arming-coat')
    a.surface('far-mail', 'M367 1760 C432 1703 535 1673 665 1649 L738 1813 L601 2053 L275 2069 Z',
              'mail', bias=.15, flow='diagonal', density=.6)
    a.mail('far-mail')
    a.surface('near-mail', 'M1281 1656 C1432 1653 1586 1703 1682 1776 L1811 2050 L1490 2160 L1340 1890 Z',
              'mail', bias=.22, flow='diagonal', density=.6)
    a.mail('near-mail')
    # Small flexible mail gussets accommodate the wider moss neck at the sides.
    a.surface('neck-gusset', 'M574 1654 C631 1600 709 1573 771 1577 C864 1620 1092 1631 1195 1571 C1302 1589 1390 1618 1449 1678 L1288 1784 L658 1801 Z',
              'mail', bias=.15, flow='horizontal', density=.65)
    a.mail('neck-gusset')

    # Rerebraces and their lower elbow lames, well inside the frame aperture.
    a.surface('far-arm', 'M235 1900 C320 1865 448 1898 507 1971 C540 2092 490 2232 466 2368 L171 2368 C151 2241 155 2113 181 2010 Z',
              bias=.07, flow='vertical')
    a.rim('M232 1927 C339 1911 429 1946 479 2013', 6, .65)
    a.line('M308 1989 C275 2154 296 2272 317 2367', mix('silver', 'bone', .18), 7, 100)
    a.surface('near-arm', 'M1513 1885 C1644 1851 1770 1901 1834 2001 C1885 2104 1888 2232 1867 2368 L1582 2368 C1591 2197 1557 2052 1513 1885 Z',
              bias=.16, flow='vertical')
    for i in range(3):
        y = 2097+i*96
        a.rim(f'M1583 {y} C1675 {y+34} 1811 {y+15} 1877 {y-19}', 6, .35)

    breast = ('M700 1692 C799 1681 891 1671 989 1664 C1130 1650 1282 1663 1418 1710 '
              'C1465 1821 1497 1957 1508 2087 C1513 2215 1571 2293 1653 2368 '
              'L443 2368 C496 2259 515 2139 526 2011 C537 1870 588 1755 700 1692 Z')
    a.surface('breastplate', breast, model=breast_model,
              flow=lambda x,y: 1.42 + .16*math.sin((x-930)/350), density=1.25)
    a.rim('M691 1705 C803 1690 896 1683 990 1676 C1130 1662 1283 1677 1406 1721', 9, .55)
    a.rim('M693 1722 C589 1850 568 1992 557 2121 C545 2223 511 2313 482 2364', 8, .55)
    a.rim('M1395 1730 C1443 1900 1465 2048 1473 2140 C1482 2243 1514 2299 1578 2364', 8, .32)
    a.rim('M932 1765 C950 1902 971 2070 1010 2329', 6, .90)
    # Subordinate flutes follow the volume; no flat graphic decoration.
    for k in range(3):
        x = 693+k*56
        a.line(f'M{x} 1852 C{x-33} 1984 {x-35} 2171 {x-69} 2280', mix('silver', 'bone', .1), 4, 100-k*15)
        a.line(f'M{x+6} 1854 C{x-27} 1984 {x-29} 2171 {x-63} 2280', mix('steel', 'forest', .25), 3, 90)
    for k in range(2):
        x = 1130+k*68
        a.line(f'M{x} 1850 C{x+61} 2038 {x+42} 2219 {x+96} 2310', mix('steel', 'silver', .25), 5, 75)
    # Two fauld lames remain legible beneath the resting hand.
    a.surface('fauld-1', 'M472 2298 C720 2320 1154 2323 1559 2288 L1614 2346 C1171 2386 736 2390 451 2356 Z',
              bias=.17, flow='horizontal', model=lambda x,y,u,v: .37+.24*u+.18*v)
    a.rim('M475 2300 C749 2327 1169 2324 1557 2290', 7, .50)
    a.surface('fauld-2', 'M455 2350 C758 2377 1242 2372 1610 2340 L1652 2368 L445 2368 Z',
              bias=.17, flow='horizontal')
    a.rim('M460 2354 C758 2378 1242 2373 1607 2343', 6, .4)

    # Foreshortened far shoulder: three dependent plates, then the smaller cap.
    far_lames = [
        ('M257 1900 C353 1905 509 1931 625 1880 L650 1945 C536 2021 361 2026 226 1962 Z',
         'M229 1960 C362 2020 531 2017 647 1943'),
        ('M267 1848 C391 1842 514 1860 622 1824 L645 1892 C543 1951 372 1953 241 1906 Z',
         'M245 1903 C370 1949 539 1947 642 1890'),
        ('M291 1799 C407 1782 528 1801 621 1778 L639 1837 C538 1885 390 1895 262 1855 Z',
         'M266 1852 C390 1889 535 1880 636 1835'),
    ]
    for i, (d, edge) in enumerate(far_lames):
        a.surface(f'far-lame-{i}', d, bias=.09+i*.015, flow='horizontal')
        a.rim(edge, 6, .65)
        a.rivet(282+i*18, 1935-i*53, 4)
        a.rivet(614, 1921-i*51, 4)
    a.surface('far-pauldron', 'M265 1814 C278 1780 321 1746 365 1734 C432 1700 500 1682 568 1681 C625 1679 662 1728 662 1796 C577 1853 421 1871 291 1849 Z',
              flow='arc', model=lambda x,y,u,v: .14+.25*u+.40*v-.1*np.exp(-((u-.32)/.2)**2), density=1.4)
    a.rim('M277 1818 C365 1853 547 1856 649 1793', 9, .8)
    a.line('M285 1799 C318 1765 360 1750 403 1733 C463 1713 511 1699 562 1696', mix('silver', 'bone', .5), 6, 210)
    a.line('M359 1770 C407 1750 494 1724 547 1727', mix('bone', 'silver', .65), 13, 90)
    for x,y in [(300,1822),(374,1837),(477,1833),(579,1813),(635,1786)]:
        a.rivet(x,y,4.7)

    # Near shoulder: broader and higher, with four clearly overlapping lames.
    near_lames = [
        ('M1376 1921 C1481 1993 1698 2023 1822 1952 L1843 2026 C1700 2113 1483 2059 1361 1984 Z',
         'M1365 1981 C1488 2054 1696 2107 1839 2024'),
        ('M1357 1866 C1480 1936 1686 1968 1798 1905 L1826 1971 C1697 2049 1480 2008 1371 1935 Z',
         'M1375 1932 C1485 2002 1693 2043 1822 1969'),
        ('M1338 1816 C1461 1871 1662 1911 1772 1853 L1808 1923 C1693 1981 1481 1952 1357 1882 Z',
         'M1361 1879 C1483 1946 1690 1975 1804 1921'),
    ]
    for i,(d,edge) in enumerate(near_lames):
        a.surface(f'near-lame-{i}', d, bias=.10, flow='horizontal', density=1.15)
        a.rim(edge, 8, .58)
        a.rivet(1402-i*14, 1970-i*52, 5)
        a.rivet(1796-i*20, 2000-i*52, 5)
    a.surface('near-pauldron', 'M1304 1765 C1328 1703 1390 1677 1460 1675 C1501 1671 1547 1677 1575 1686 C1680 1703 1760 1768 1799 1847 C1690 1914 1451 1900 1327 1820 Z',
              flow='arc', model=lambda x,y,u,v: .16+.33*u+.27*v-.20*np.exp(-((u-.32)/.18)**2), density=1.45)
    a.rim('M1320 1802 C1442 1881 1664 1908 1785 1845', 10, .7)
    a.line('M1327 1753 C1365 1705 1421 1691 1486 1690 C1522 1688 1557 1695 1583 1704', mix('bone','silver',.5), 7, 210)
    a.line('M1375 1729 C1416 1711 1479 1707 1528 1714', mix('bone','silver',.45), 19, 90)
    a.line('M1504 1731 C1600 1750 1669 1783 1720 1827', mix('steel','silver',.6), 7, 160)
    a.line('M1507 1738 C1597 1754 1656 1787 1706 1829', mix('steel','forest',.2), 6, 100)
    for x,y in [(1345,1808),(1421,1844),(1530,1868),(1639,1873),(1747,1854)]:
        a.rivet(x,y,5.5)

    # Fitted U-shaped gorget, centred on (978,1600); lower lip cups the throat.
    a.surface('collar-padding', 'M742 1559 C843 1611 1086 1627 1199 1554 L1229 1581 C1157 1668 819 1670 717 1589 Z',
              'cloth', bias=.13, flow='horizontal')
    a.surface('gorget', 'M748 1580 C861 1641 1102 1647 1208 1578 C1235 1600 1264 1626 1288 1659 C1247 1731 1111 1768 958 1763 C830 1762 724 1726 684 1676 C708 1642 728 1611 748 1580 Z',
              flow='horizontal', model=lambda x,y,u,v: .17+.28*u+.37*v-.18*np.exp(-((v-.28)/.18)**2), density=1.4)
    a.rim('M749 1585 C862 1644 1101 1650 1207 1584', 10, .9)
    a.rim('M695 1673 C780 1746 1119 1798 1276 1659', 8, .6)
    a.rim('M721 1645 C829 1722 1122 1746 1251 1639', 4, .42)
    a.line('M927 1664 C935 1698 945 1734 958 1755', mix('steel','forest',.3), 5, 130)
    a.line('M923 1664 C931 1698 941 1734 954 1755', mix('bone','silver',.65), 4, 180)
    for x,y in [(735,1655),(819,1708),(1110,1717),(1238,1655)]:
        a.rivet(x,y,4.5)
    # A restrained leather closure on the shadow-side gorget, not tier regalia.
    a.surface('collar-closure', 'M1203 1630 L1241 1622 L1269 1662 L1230 1679 Z', 'leather', bias=.25, flow='diagonal', density=.5)
    a.line('M1213 1634 L1238 1629 L1256 1658 L1233 1668 Z', mix('ochre','steel',.6), 4, 230)
    a.rivet(1235,1643,3.2,True)
    a.save('attire-front.knight-armour.png')
    return a.im


def finger_path(points, widths):
    # Closed articulated finger silhouette around a curved centre line.
    upper = [(x, y-w*.5) for (x,y),w in zip(points,widths)]
    lower = [(x, y+w*.5) for (x,y),w in zip(points,widths)]
    pts = upper + lower[::-1]
    return 'M'+' L'.join(f'{x:.1f} {y:.1f}' for x,y in pts)+' Z'


def paint_gauntlet():
    g = Painter()
    # Forearm enters from the near arm; the glove's self-shadow is kept local.
    g.surface('under-glove', 'M1122 2122 C1164 2086 1240 2080 1289 2110 C1347 2102 1407 2108 1472 2138 C1612 2185 1751 2252 1829 2300 L1865 2367 L1495 2367 C1430 2327 1362 2312 1260 2315 C1195 2315 1153 2289 1116 2254 L1097 2194 Z',
              'leather', bias=.3, flow='horizontal', density=.8)
    g.surface('vambrace', 'M1462 2147 C1593 2195 1743 2249 1832 2298 L1866 2367 L1519 2367 C1443 2325 1387 2303 1343 2261 Z',
              flow=lambda x,y: .45, model=lambda x,y,u,v: .21+.26*u+.31*v, density=1.25)
    g.rim('M1474 2157 C1599 2212 1732 2259 1827 2308', 8, .6)
    g.line('M1459 2193 C1596 2247 1715 2291 1827 2352', mix('silver','bone',.3), 9, 150)
    g.line('M1450 2204 C1603 2268 1691 2303 1805 2366', mix('steel','forest',.2), 8, 110)
    for x,y in [(1511,2193),(1630,2241),(1760,2293)]:
        g.rivet(x,y,5)
    g.surface('cuff', 'M1326 2089 C1397 2090 1461 2111 1510 2147 C1466 2224 1449 2292 1479 2354 C1405 2358 1318 2326 1255 2283 C1279 2220 1303 2153 1326 2089 Z',
              flow=lambda x,y: 1.83, model=lambda x,y,u,v: .18+.32*u+.3*v-.12*np.sin(v*3.1), density=1.3)
    g.rim('M1330 2098 C1394 2102 1451 2122 1497 2150', 9, .8)
    g.rim('M1265 2280 C1331 2321 1401 2345 1467 2344', 8, .45)
    # Three wrist lames telescope out of the flared cuff.
    for i in range(3):
        x = 1280-i*37
        g.surface(f'wrist-lame-{i}', f'M{x+31} 2120 C{x+65} 2141 {x+64} 2248 {x+26} 2307 L{x-19} 2286 C{x+13} 2237 {x+14} 2159 {x-8} 2135 Z',
                  bias=.12, flow='vertical', density=1)
        g.rim(f'M{x+21} 2130 C{x+48} 2161 {x+44} 2245 {x+14} 2292', 5, .6)
    # Leather separates the fingers. Four finger rays and an opposed thumb.
    fingers = [
        ([(1156,2154),(1048,2135),(957,2143),(866,2164)], [60,55,49,35]),
        ([(1140,2203),(1018,2191),(918,2203),(804,2230)], [60,57,49,34]),
        ([(1155,2251),(1046,2251),(954,2270),(846,2294)], [56,52,45,32]),
        ([(1196,2285),(1100,2300),(1037,2319),(952,2335)], [45,43,37,29]),
    ]
    for j,(pts,widths) in enumerate(fingers[::-1]):
        g.surface(f'finger-under-{j}', finger_path(pts, [w+5 for w in widths]),
                  'leather', bias=.4, flow='horizontal', density=.6)
    g.surface('metacarpal', 'M1137 2112 C1178 2084 1257 2097 1302 2132 C1318 2193 1297 2258 1268 2300 C1226 2320 1170 2298 1122 2264 L1097 2212 L1110 2166 Z',
              flow=lambda x,y: .4, model=lambda x,y,u,v: .20+.32*u+.27*v, density=1.3)
    # Each articulated digit has three separate overlapping steel scales.
    for j,(pts,widths) in enumerate(fingers):
        for k in [2,1,0]:
            (x1,y1),(x2,y2) = pts[k:k+2]
            w1,w2 = widths[k:k+2]
            d = (f'M{x1+8} {y1-w1/2} Q{(x1+x2)/2} {(y1+y2)/2-w1*.68} {x2} {y2-w2/2} '
                 f'Q{x2-18} {y2} {x2} {y2+w2/2} Q{(x1+x2)/2} {(y1+y2)/2+w1*.55} {x1+8} {y1+w1/2} '
                 f'Q{x1+20} {y1} {x1+8} {y1-w1/2} Z')
            g.surface(f'finger-{j}-scale-{k}', d, bias=.02+j*.035, flow='horizontal',
                      model=lambda x,y,u,v: .16+.12*u+.49*v, density=1.25)
            g.rim(f'M{x2+10} {y2-w2*.48} Q{x2-7} {y2} {x2+10} {y2+w2*.46}', 4, .6)
            g.line(f'M{x1-8} {y1-w1*.29} Q{(x1+x2)/2} {(y1+y2)/2-w1*.34} {x2+17} {y2-w2*.29}',
                   mix('bone','silver',.6), 4, 190)
            if k < 2:
                g.rivet(x2+16,y2,3.2)
        # Raised knuckle facet with a rounded lobe, visibly part of the backplate.
        x,y = pts[0]
        g.surface(f'knuckle-{j}', f'M{x-15} {y-28} Q{x+15} {y-37} {x+39} {y-10} L{x+36} {y+17} Q{x+10} {y+28} {x-18} {y+22} Q{x-32} {y} {x-15} {y-28} Z',
                  bias=.02+j*.035, flow='horizontal', density=1.2)
        g.line(f'M{x-9} {y-20} Q{x+13} {y-24} {x+29} {y-6}', mix('bone','silver',.5), 5, 220)
        g.line(f'M{x+29} {y+10} L{x+22} {y+21}', mix('steel','forest',.4), 4, 200)
    # The thumb opposes the fingers and rests above the index plate.
    g.surface('thumb-leather', 'M1267 2132 C1230 2113 1211 2087 1189 2077 C1171 2075 1159 2086 1145 2085 C1124 2087 1089 2108 1059 2134 C1047 2148 1054 2167 1077 2170 C1105 2159 1134 2146 1169 2140 L1219 2181 C1247 2177 1264 2158 1267 2132 Z',
              'leather', bias=.38, flow='horizontal', density=.8)
    g.surface('thumb-base', 'M1261 2132 C1231 2118 1209 2093 1189 2082 C1173 2081 1146 2097 1136 2117 L1175 2150 L1218 2175 C1240 2171 1258 2153 1261 2132 Z',
              bias=.03, flow='diagonal', density=1.2)
    g.rim('M1186 2087 C1174 2093 1159 2106 1153 2117', 5, .9)
    g.surface('thumb-end', 'M1149 2088 C1127 2090 1090 2111 1062 2137 C1055 2148 1062 2163 1077 2164 C1100 2154 1132 2140 1162 2133 L1178 2113 Z',
              flow='horizontal', bias=.02, density=1.2)
    g.rim('M1133 2101 Q1125 2118 1144 2139', 4, .65)
    g.line('M1125 2108 Q1096 2120 1075 2140', mix('bone','silver',.55), 4, 200)
    for x,y in [(1232,2137),(1285,2182),(1263,2251),(1434,2137),(1398,2319)]:
        g.rivet(x,y,3.5)
    g.save('prop-front.knight-gauntlet.png')
    return g.im


def proof(armour, gauntlet):
    # An unvarnished fit proof only. The plain field is not a library background.
    canvas = Image.new('RGBA', (W,H), col('umber')+(255,))
    for name in ['layers/skins/moss.png']:
        canvas = Image.alpha_composite(canvas, Image.open(ROOT/name).convert('RGBA'))
    canvas = Image.alpha_composite(canvas, armour)
    canvas = Image.alpha_composite(canvas, gauntlet)
    canvas = Image.alpha_composite(canvas, Image.open(ROOT/'layers/frames/common.png').convert('RGBA'))
    (OUT/'review').mkdir(exist_ok=True)
    canvas.convert('RGB').resize((1024,1280), Image.Resampling.LANCZOS).save(OUT/'review/moss-common-fit.jpg', quality=94, subsampling=0)
    # Full-resolution lower-bust detail makes overlaps and brush marks reviewable.
    canvas.crop((192,1500,1888,2368)).convert('RGB').save(OUT/'review/armour-detail.jpg', quality=95, subsampling=0)

    # Diagnostic overlay reads the actual shared template, not copied landmarks.
    template = ET.parse(ROOT/'template/bust.svg').getroot()
    find = lambda ident: next(e for e in template.iter() if e.get('id') == ident)
    registration = json.loads(find('kekborn-registration').text)
    diag = Image.new('RGBA', (W,H), col('umber')+(255,))
    diag = Image.alpha_composite(diag, Image.open(ROOT/'layers/skins/moss.png').convert('RGBA'))
    for layer in (armour, gauntlet):
        half = layer.copy()
        half.putalpha(half.getchannel('A').point(lambda a: round(a*.5)))
        diag = Image.alpha_composite(diag, half)
    diag = Image.alpha_composite(diag, Image.open(ROOT/'layers/frames/common.png').convert('RGBA'))
    guide = Image.new('RGBA', (W,H))
    ctx = aggdraw.Draw(guide)
    for ident in ('shoulder-mass', 'head-outline'):
        ctx.path(path(find(ident).get('d')), None, aggdraw.Pen('#D7C7A3', 3))
    ctx.flush()
    diag = Image.alpha_composite(diag, guide)
    d = ImageDraw.Draw(diag)
    font = ImageFont.load_default(size=26)
    small = ImageFont.load_default(size=21)
    gold = '#C9A45A'
    cyan = '#8BBEB2'
    d.text((190,220), 'KNIGHT / TEMPLATE FIT', font=ImageFont.load_default(size=36), fill=gold)
    d.text((190,271), 'Attire + prop at 50% opacity; guide coordinates from template/bust.svg', font=small, fill='#D7C7A3')
    ap = registration['frameAperture']
    d.rectangle((ap['x0'],ap['y0'],ap['x1']-1,ap['y1']-1), outline=gold, width=3)
    for key in ('bannerArms','railArms'):
        reserve = registration['reserves'][key]
        c = reserve['clearSpace']
        d.rectangle((reserve['x0']-c,reserve['y0']-c,reserve['x1']+c-1,reserve['y1']+c-1), outline=gold, width=4)
        d.rectangle((reserve['x0'],reserve['y0'],reserve['x1']-1,reserve['y1']-1), outline=gold, width=2)
    d.text((1480,680),'BANNER SHIELD + CLEARANCE',font=small,fill=gold)
    d.text((1105,2452),'RAIL SHIELD + CLEARANCE',font=small,fill=gold)
    for key in ('farEye','nearEye','throat','shoulderFar','shoulderNear'):
        p = registration['landmarks'][key]
        x,y=p['x'],p['y']
        d.line((x-22,y,x+22,y),fill=cyan,width=4)
        d.line((x,y-22,x,y+22),fill=cyan,width=4)
        if key.startswith('shoulder'):
            dx = -120 if key == 'shoulderFar' else -35
            d.text((x+dx,y+44),f'{x},{y}',font=font,fill=cyan)
    neck = find('neck-opening')
    cx,cy,rx,ry = (float(neck.get(k)) for k in ('cx','cy','rx','ry'))
    d.ellipse((cx-rx,cy-ry,cx+rx,cy+ry),outline=cyan,width=4)
    d.text((800,1790),'NECK 978,1600 / rx210 ry64',font=small,fill=cyan)
    d.line((365,1760,1575,1712),fill=cyan,width=2)
    diag.convert('RGB').resize((1024,1280),Image.Resampling.LANCZOS).save(OUT/'review/registration.jpg',quality=94,subsampling=0)


if __name__ == '__main__':
    armour = paint_armour()
    gauntlet = paint_gauntlet()
    proof(armour, gauntlet)
    print('Painted two 2048x2560 RGBA8 layers and three unvarnished fit proofs.')
