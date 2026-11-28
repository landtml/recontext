# Recontext architecture diagram: shrink pipeline, archive band, recall pipeline. Same theme as logo.py.
# Run: blender -b -P assets/architecture.py -- <out_dir> [scale_percent]
import bpy, math, sys, os

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else os.path.dirname(os.path.abspath(__file__))
PCT = int(argv[1]) if len(argv) > 1 else 200

RED, RED_DK, RED_LT, RED_SOFT = '#D63A3A', '#B92E2E', '#E86A64', '#F2B8B0'
WHITE, BG, CARD = '#FFF6F2', '#FBF1EC', '#FFFFFF'
INK, MUTED, LINE, TINT, SHADOW = '#2B1D1A', '#8A6F68', '#EBD3CC', '#FBE3DE', '#EEDDD6'
FONT_DIR = '/usr/share/fonts/opentype/inter/'

def lin(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
F = {w: bpy.data.fonts.load(FONT_DIR + f'Inter-{w}.otf') for w in ('Regular', 'Medium', 'SemiBold', 'Bold')}

_mats = {}
def mat(hex_):
    if hex_ in _mats:
        return _mats[hex_]
    m = bpy.data.materials.new(hex_)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = lin(hex_)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    _mats[hex_] = m
    return m

def link(o):
    scene.collection.objects.link(o)
    return o

def rrect(x, y, w, h, r, z, color):
    me = bpy.data.meshes.new('r')
    me.from_pydata([(-w/2, -h/2, 0), (w/2, -h/2, 0), (w/2, h/2, 0), (-w/2, h/2, 0)], [], [(0, 1, 2, 3)])
    o = link(bpy.data.objects.new('r', me))
    o.location = (x, y, z)
    if r > 0:
        b = o.modifiers.new('round', 'BEVEL')
        b.affect = 'VERTICES'
        b.width = min(r, min(w, h) / 2 - 0.0005)
        b.segments = 20
    me.materials.append(mat(color))
    return o

def circle(x, y, rad, z, color):
    return rrect(x, y, 2 * rad, 2 * rad, rad, z, color)

def poly(pts, z, color, ox=0, oy=0):
    me = bpy.data.meshes.new('p')
    me.from_pydata([(ox + px, oy + py, z) for px, py in pts], [], [tuple(range(len(pts)))])
    o = link(bpy.data.objects.new('p', me))
    me.materials.append(mat(color))
    return o

def stroke(pts, width, z, color, ox=0, oy=0):
    cu = bpy.data.curves.new('s', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = width / 2
    cu.bevel_resolution = 4
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, (px, py) in enumerate(pts):
        sp.points[i].co = (ox + px, oy + py, z, 1)
    o = link(bpy.data.objects.new('s', cu))
    cu.materials.append(mat(color))
    return o

def text(s, x, y, size, color, weight='Regular', align='CENTER', z=0.05, spacing=1.0):
    cu = bpy.data.curves.new('t', 'FONT')
    cu.body = s
    cu.font = F[weight]
    cu.size = size
    cu.align_x = align
    cu.align_y = 'CENTER'
    cu.space_character = spacing
    cu.space_line = 1.1
    o = link(bpy.data.objects.new('t', cu))
    o.location = (x, y, z)
    cu.materials.append(mat(color))
    return o

def arrow(x1, y1, x2, y2, color=RED, width=0.035, head=0.13, z=0.02):
    d = math.hypot(x2 - x1, y2 - y1)
    ux, uy = (x2 - x1) / d, (y2 - y1) / d
    bx, by = x2 - ux * head, y2 - uy * head
    stroke([(x1, y1), (bx + ux * 0.01, by + uy * 0.01)], width, z, color)
    hw = head * 0.62
    poly([(bx - uy * hw, by + ux * hw), (bx + uy * hw, by - ux * hw), (x2, y2)], z, color)

def arc_pts(cx, cy, r, a0, a1, n=24):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]

# ---------- icons (drawn around 0,0, about 0.4 wide) ----------
def ic_chat(x, y, z, c, c2):
    rrect(x - 0.05, y + 0.05, 0.3, 0.2, 0.07, z, c2)
    rrect(x + 0.06, y - 0.07, 0.3, 0.2, 0.07, z + 0.002, c)
    poly([(0.12, -0.17), (0.16, -0.25), (0.02, -0.17)], z + 0.002, c, x, y)

def ic_db(x, y, z, c, c2):
    for i, yy in enumerate((0.12, 0.0, -0.12)):
        rrect(x, y + yy, 0.34, 0.09, 0.045, z, c if i != 1 else c2)

def ic_funnel(x, y, z, c, c2):
    poly([(-0.18, 0.15), (0.18, 0.15), (0.045, -0.02), (0.045, -0.17), (-0.045, -0.12), (-0.045, -0.02)], z, c, x, y)

def ic_spark(x, y, z, c, c2):
    def star(cx, cy, R, r):
        pts = []
        for i in range(8):
            a = math.pi / 2 + i * math.pi / 4
            rad = R if i % 2 == 0 else r
            pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
        poly(pts, z, c, x, y)
    star(-0.04, -0.02, 0.19, 0.055)
    star(0.14, 0.13, 0.085, 0.026)

def ic_list(x, y, z, c, c2):
    for yy in (0.11, 0.0, -0.11):
        circle(x - 0.13, y + yy, 0.032, z, c)
        rrect(x + 0.04, y + yy, 0.22, 0.05, 0.025, z, c2 if yy == 0.0 else c)

def ic_recall(x, y, z, c, c2, R=0.13, w=0.05):
    a0, a1 = math.radians(150), math.radians(440)
    stroke(arc_pts(0, 0, R, a0, a1, 40), w, z, c, x, y)
    px, py = R * math.cos(a1), R * math.sin(a1)
    nx, ny, tx, ty = math.cos(a1), math.sin(a1), -math.sin(a1), math.cos(a1)
    poly([(px + nx * 0.06, py + ny * 0.06), (px - nx * 0.06, py - ny * 0.06), (px + tx * 0.07, py + ty * 0.07)], z, c, x, y)

def ic_question(x, y, z, c, c2):
    text('?', x, y + 0.01, 0.42, c, 'Bold', z=z)

def ic_search(x, y, z, c, c2):
    stroke(arc_pts(-0.035, 0.035, 0.11, 0, 2 * math.pi, 40), 0.05, z, c, x, y)
    stroke([(0.045, -0.045), (0.15, -0.15)], 0.065, z, c, x, y)

def ic_check(x, y, z, c, c2):
    stroke([(-0.14, 0.0), (-0.04, -0.1), (0.15, 0.11)], 0.065, z, c, x, y)

def ic_quote(x, y, z, c, c2):
    rrect(x, y, 0.3, 0.36, 0.05, z, c)
    for i, yy in enumerate((0.09, 0.0, -0.09)):
        rrect(x - 0.02 + (0.02 if i == 2 else 0), y + yy, 0.18 - (0.06 if i == 2 else 0), 0.035, 0.017, z + 0.002, c2)

def ic_shield(x, y, z, c, c2):
    pts = [(-0.15, 0.16), (0.15, 0.16), (0.15, 0.02)] + arc_pts(0, 0.02, 0.15, 0, -math.pi / 2, 8)[1:] \
        + arc_pts(0, 0.02, 0.15, -math.pi / 2, -math.pi, 8)[1:]
    pts = [(px, py if py >= 0.02 else 0.02 + (py - 0.02) * 1.25) for px, py in pts]
    poly(pts, z, c, x, y)
    stroke([(-0.06, 0.03), (-0.01, -0.03), (0.08, 0.08)], 0.04, z + 0.003, c2, x, y)

# ---------- cards ----------
CW, CH, GAP = 2.62, 2.2, 0.46
XS = [-9.0 + CW / 2 + i * (CW + GAP) for i in range(6)]
STYLE = {
    #        fill     border  title  sub       iconbg   icon   icon2     pillbg  pilltext
    'code':  (CARD,   LINE,   INK,   MUTED,    TINT,    RED,   RED_SOFT, TINT,   RED),
    'haiku': (RED,    None,   WHITE, '#FBD6CF', RED_LT, WHITE, '#F6C2BA', RED_DK, WHITE),
    'ctx':   (CARD,   RED,    INK,   MUTED,    RED,     WHITE, '#F6C2BA', INK,   WHITE),
    'safe':  ('#F8E4DE', None, INK,  MUTED,    CARD,    RED,   WHITE,    CARD,   MUTED),
}

def card(x, y, kind, icon, title, sub, tag):
    fill, border, tc, sc, ibg, ic, ic2, pbg, ptc = STYLE[kind]
    rrect(x, y - 0.06, CW, CH, 0.2, -0.02, SHADOW)
    if border:
        bw = 0.04 if kind == 'ctx' else 0.025
        rrect(x, y, CW + 2 * bw, CH + 2 * bw, 0.2 + bw, -0.01, border)
    rrect(x, y, CW, CH, 0.2, 0.0, fill)
    circle(x, y + 0.56, 0.34, 0.01, ibg)
    icon(x, y + 0.56, 0.02, ic, ic2)
    text(title, x, y - 0.03, 0.225, tc, 'SemiBold')
    for i, line in enumerate(sub):
        text(line, x, y - 0.33 - i * 0.215, 0.16, sc, 'Regular')
    pw = len(tag) * 0.098 + 0.3
    rrect(x, y - 0.86, pw, 0.24, 0.12, 0.01, pbg)
    text(tag, x, y - 0.862, 0.118, ptc, 'Bold', spacing=1.25)

def logo(cx, cy, s):
    rrect(cx, cy, s, s, 0.22 * s, 0.0, RED)
    ic_recall(cx, cy, 0.02, WHITE, WHITE, R=0.27 * s, w=0.085 * s)
    for i, w in enumerate((0.26, 0.20, 0.12)):
        rrect(cx + (-0.13 + w / 2) * s, cy + (0.085 - i * 0.085) * s, w * s, 0.05 * s, 0.024 * s, 0.02, WHITE)

# background
rrect(0, 0, 20, 12, 0, -0.1, BG)

# header
logo(-8.55, 4.55, 0.9)
text('Recontext', -7.9, 4.71, 0.5, INK, 'Bold', align='LEFT')
text('A token-efficient shrink for Claude Code, with exact recall', -7.9, 4.25, 0.21, MUTED, align='LEFT')
for lx, (sw, label) in zip((3.85, 5.3, 7.2),  (('code', 'Code'), ('haiku', 'Haiku call'), ('ctx', 'Session context'))):
    fill, border = STYLE[sw][0], STYLE[sw][1]
    if border:
        rrect(lx, 4.55, 0.32, 0.32, 0.09, -0.01, border)
    rrect(lx, 4.55, 0.27 if border else 0.32, 0.27 if border else 0.32, 0.08, 0.0, fill)
    text(label, lx + 0.28, 4.545, 0.17, INK, 'Medium', align='LEFT')

# shrink row
Y1 = 2.1
text('SHRINK  ·  WHEN THE CONTEXT WINDOW FILLS', -9.0, 3.58, 0.155, RED, 'Bold', align='LEFT', spacing=1.2)
row1 = [
    ('ctx',   ic_chat,   'Conversation',   ['the full session,', 'e.g. 300k tokens'],          'BEFORE'),
    ('code',  ic_db,     'Index + archive', ['every message split up;', 'exact items merged'],      'CODE'),
    ('code',  ic_funnel, 'Digest',          ['tool output pruned,', 'at most 80k tokens'],     'CODE'),
    ('haiku', ic_spark,  'State of work',   ['goal, decisions,', 'next step'],                 'HAIKU'),
    ('code',  ic_list,   'Facts + tail',    ['items in play, errors;', 'recent messages kept'], 'CODE'),
    ('ctx',   ic_recall, 'Fresh context',   ['handoff + tail;', 'the model continues'],        'AFTER'),
]
for x, (k, ic, t, s, tag) in zip(XS, row1):
    card(x, Y1, k, ic, t, s, tag)
for i in range(5):
    arrow(XS[i] + CW / 2 + 0.07, Y1, XS[i + 1] - CW / 2 - 0.07, Y1)

# archive band
BY, BH = 0.45, 0.56
bx0, bx1 = XS[1] - CW / 2, XS[4] + CW / 2
rrect((bx0 + bx1) / 2, BY, bx1 - bx0, BH, BH / 2, 0.0, INK)
for i, yy in enumerate((0.1, 0.0, -0.1)):
    rrect(bx0 + 0.5, BY + yy, 0.3, 0.07, 0.035, 0.02, RED_LT if i == 1 else WHITE)
text('ARCHIVE + INDEXES ON DISK', bx0 + 0.85, BY, 0.155, WHITE, 'Bold', align='LEFT', spacing=1.2)
text('every message, full tool result and exact item, kept and searchable', bx0 + 3.55, BY, 0.18, '#D9C4BD', align='LEFT')
arrow(XS[1], Y1 - CH / 2 - 0.05, XS[1], BY + BH / 2 + 0.04)

# recall row (right to left)
Y2 = -1.85
text('RECALL  ·  WHEN THE MODEL NEEDS AN EXACT DETAIL', -9.0, -0.38, 0.155, RED, 'Bold', align='LEFT', spacing=1.2)
row2 = [
    (XS[5], 'ctx',   ic_question, 'Model asks',      ['recall(question,', 'leads)'],                'MODEL'),
    (XS[4], 'code',  ic_search,   'Lookup + search', ['exact item: code answers;', 'else BM25 + leads'],      'CODE'),
    (XS[3], 'haiku', ic_spark,    'Reader',          ['answers from the', 'evidence only'],         'HAIKU'),
    (XS[2], 'code',  ic_check,    'Gates',           ['each quote found', 'verbatim, numbers sourced'], 'CODE'),
    (XS[1], 'ctx',   ic_quote,    'Answer',          ['with sources and', 'exact quotes'],          'TOOL RESULT'),
    (XS[0], 'safe',  ic_shield,   'Never fails',     ['Haiku down: code-only', 'error: built-in compact'], 'FALLBACK'),
]
for x, k, ic, t, s, tag in row2:
    card(x, Y2, k, ic, t, s, tag)
for i in range(5, 2, -1):
    arrow(XS[i] - CW / 2 - 0.07, Y2, XS[i - 1] + CW / 2 + 0.07, Y2)
arrow(XS[5], Y1 - CH / 2 - 0.05, XS[5], Y2 + CH / 2 + 0.05)
arrow(XS[4], BY - BH / 2 - 0.04, XS[4], Y2 + CH / 2 + 0.05)

# return loop: answer back to the model
ly, rr = Y2 - CH / 2 - 0.42, 0.2
xa, xb = XS[1], XS[5]
ytop = Y2 - CH / 2 - 0.05
pts = [(xa, ytop - 0.02)] + arc_pts(xa + rr, ly + rr, rr, math.pi, 1.5 * math.pi, 10) \
    + arc_pts(xb - rr, ly + rr, rr, 1.5 * math.pi, 2 * math.pi, 10) + [(xb, ytop - 0.14)]
stroke(pts, 0.03, 0.02, RED_SOFT)
poly([(xb - 0.08, ytop - 0.14), (xb + 0.08, ytop - 0.14), (xb, ytop)], 0.02, RED_SOFT)
mid = (xa + xb) / 2
rrect(mid, ly, 3.5, 0.4, 0.2, 0.05, BG)
text('the answer goes back to the model as the tool result', mid, ly, 0.17, MUTED, 'Medium', z=0.07)

# footer stats
FY = -4.55
rrect(0, FY + 0.55, 18.0, 0.02, 0, 0.0, LINE)
for x, big, cap in ((-6.0, '0', 'calls to the session model per shrink'),
                    (0.0, '1', 'Haiku call per shrink, at most 80k tokens'),
                    (6.0, 'all', 'messages kept: recall reaches every one')):
    text(big, x, FY + 0.02, 0.56, RED, 'Bold')
    text(cap, x, FY - 0.42, 0.2, MUTED, 'Medium')

# camera + render
cam_d = bpy.data.cameras.new('cam')
cam_d.type = 'ORTHO'
cam_d.ortho_scale = 19.2
cam = link(bpy.data.objects.new('cam', cam_d))
cam.location = (0, 0, 5)
scene.camera = cam
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
chosen = None
for kind in ('HIP', 'OPTIX', 'CUDA', 'ONEAPI', 'METAL'):
    try:
        prefs.compute_device_type = kind
    except TypeError:
        continue
    prefs.get_devices()
    gpus = [d for d in prefs.devices if d.type == kind]
    if gpus:
        for d in prefs.devices:
            d.use = d.type == kind
        chosen = kind
        break
scene.cycles.device = 'GPU' if chosen else 'CPU'
print('RENDER DEVICE:', chosen or 'CPU')
scene.cycles.samples = 48
scene.cycles.use_denoising = False
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
scene.render.resolution_percentage = PCT
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
for k in ('date', 'time', 'render_time', 'frame', 'frame_range', 'memory', 'hostname', 'camera', 'lens', 'scene', 'filename', 'marker', 'sequencer_strip'):
    setattr(scene.render, 'use_stamp_' + k, False)
scene.render.use_stamp_note = False
scene.render.filepath = os.path.join(OUT, 'architecture.png')
bpy.ops.render.render(write_still=True)
