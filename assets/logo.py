# Recontext logo: red soft-cornered square, white "recall" arc arrow around three distilled-text bars.
# Run: blender -b -P assets/logo.py -- <out_dir> [size]
import bpy, math, sys, os

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else os.path.dirname(os.path.abspath(__file__))
SIZE = int(argv[1]) if len(argv) > 1 else 1024

RED = '#D63A3A'
WHITE = '#FFF6F2'

def lin(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def material(name, hex_):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = lin(hex_)
    em.inputs['Strength'].default_value = 1.0
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m

M_RED, M_WHITE = material('red', RED), material('white', WHITE)

def rounded_rect(name, w, h, r, z, mat, x=0.0, y=0.0):
    bpy.ops.mesh.primitive_plane_add(size=1, location=(x, y, z))
    o = bpy.context.object
    o.name = name
    o.scale = (w, h, 1)
    bpy.ops.object.transform_apply(scale=True)
    bev = o.modifiers.new('round', 'BEVEL')
    bev.affect = 'VERTICES'
    bev.width = r
    bev.segments = 24
    o.data.materials.append(mat)
    return o

# background tile: soft corners (radius 22% of the side)
rounded_rect('tile', 1.0, 1.0, 0.22, 0.0, M_RED)

# recall arc: 290 degrees, gap at upper left, counterclockwise towards the gap
R, STROKE = 0.27, 0.085
a0, a1 = math.radians(150), math.radians(150 + 290)
cu = bpy.data.curves.new('arc', 'CURVE')
cu.dimensions = '3D'
cu.bevel_depth = STROKE / 2
cu.bevel_resolution = 6
sp = cu.splines.new('POLY')
N = 160
sp.points.add(N - 1)
for i in range(N):
    a = a0 + (a1 - a0) * i / (N - 1)
    sp.points[i].co = (R * math.cos(a), R * math.sin(a), 0.02, 1)
arc = bpy.data.objects.new('arc', cu)
scene.collection.objects.link(arc)
cu.materials.append(M_WHITE)

# arrowhead at the arc's end, pointing along the counterclockwise tangent
px, py = R * math.cos(a1), R * math.sin(a1)
nx, ny = math.cos(a1), math.sin(a1)          # outward normal
tx, ty = -math.sin(a1), math.cos(a1)         # tangent
HW, HL = 0.095, 0.11
verts = [(px + nx * HW, py + ny * HW, 0.03), (px - nx * HW, py - ny * HW, 0.03),
         (px + tx * HL, py + ty * HL, 0.03)]
me = bpy.data.meshes.new('head')
me.from_pydata(verts, [], [(0, 1, 2)])
head = bpy.data.objects.new('head', me)
scene.collection.objects.link(head)
me.materials.append(M_WHITE)

# three distilled-text bars, left aligned, getting shorter
BAR_H, GAP, LEFT = 0.05, 0.085, -0.13
for i, w in enumerate((0.26, 0.20, 0.12)):
    rounded_rect(f'bar{i}', w, BAR_H, BAR_H / 2 - 0.001, 0.02, M_WHITE,
                 x=LEFT + w / 2, y=GAP - i * GAP)

# camera: orthographic, straight down, small margin
cam_d = bpy.data.cameras.new('cam')
cam_d.type = 'ORTHO'
cam_d.ortho_scale = 1.06
cam = bpy.data.objects.new('cam', cam_d)
cam.location = (0, 0, 5)
scene.collection.objects.link(cam)
scene.camera = cam

# render: Cycles on the GPU, transparent background, exact colors
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
        chosen = f"{kind}: {', '.join(d.name for d in gpus)}"
        break
scene.cycles.device = 'GPU' if chosen else 'CPU'
print('RENDER DEVICE:', chosen or 'CPU (no GPU found)')
scene.cycles.samples = 64
scene.cycles.use_denoising = False
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.join(OUT, 'logo.png')
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'logo.blend'))
