"""Bake the generated orthographic sheet onto human.glb's existing UVs.
Offline only: Python + numpy, scipy, Pillow. Never writes model geometry.
"""
import importlib.util
import pathlib
import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, binary_fill_holes, distance_transform_edt, map_coordinates

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('anatomy_surface', ROOT / 'scripts/build-anatomy-surface.py')
surface = importlib.util.module_from_spec(spec)
spec.loader.exec_module(surface)


def bake():
    doc, binary = surface.load_glb(ROOT / 'public/models/human.glb')
    primitive = doc['meshes'][0]['primitives'][0]
    attrs = primitive['attributes']
    positions = surface.read_acc(doc, binary, attrs['POSITION'])
    normals = surface.read_acc(doc, binary, attrs['NORMAL'])
    uv = surface.read_acc(doc, binary, attrs['TEXCOORD_0'])
    indices = surface.read_acc(doc, binary, primitive['indices']).reshape(-1, 3)
    size = 2048
    xyz = np.zeros((size, size, 3), dtype=np.float32)
    normal = np.zeros_like(xyz)
    valid = np.zeros((size, size), dtype=bool)
    for tri in indices:
        t = uv[tri] * size - .5
        lo = np.maximum(0, np.ceil(t.min(axis=0)).astype(int))
        hi = np.minimum(size - 1, np.floor(t.max(axis=0)).astype(int))
        if np.any(lo > hi):
            continue
        x, y = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(lo[1], hi[1] + 1))
        a, b, c = t
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        w0 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den
        w1 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den
        weights = np.stack([w0, w1, 1 - w0 - w1], axis=-1)
        inside = np.all(weights >= -1e-6, axis=-1)
        ys, xs = slice(lo[1], hi[1] + 1), slice(lo[0], hi[0] + 1)
        xyz[ys, xs][inside] = (weights @ positions[tri])[inside]
        normal[ys, xs][inside] = (weights @ normals[tri])[inside]
        valid[ys, xs] |= inside
    sheet = np.asarray(Image.open(ROOT / 'assets/skins/ssj-projection.png').convert('RGB'))
    height, width = sheet.shape[:2]
    assert width == height * 2, 'Expected registered front/back square panels'
    panels = []
    for panel in np.split(sheet, 2, axis=1):
        # Extend painted edges so a slightly different drawn silhouette never paints grey onto skin.
        painted = np.ptp(panel.astype(float), axis=-1) > panel.max(axis=-1) * .33
        assert painted.sum() > height * height * .1, 'Character paint is missing'
        nearest = distance_transform_edt(~binary_erosion(painted, iterations=2), return_distances=False, return_indices=True)
        panels.append(panel[tuple(nearest)])
    face = np.asarray(Image.open(ROOT / 'assets/skins/ssj-face.png').convert('RGB'))
    face_size = face.shape[0]
    assert face.shape[1] == face_size, 'Expected a square registered face patch'
    face_mask = binary_fill_holes(np.ptp(face.astype(float), axis=-1) > face.max(axis=-1) * .33)
    assert face_mask.sum() > face_size * face_size * .15, 'Face paint is missing'
    nearest_face = distance_transform_edt(~face_mask, return_distances=False, return_indices=True)
    extended_face = face[tuple(nearest_face)]
    def face_v(y):
        return (1.81 - y) / .32 * (face_size - 1)
    points = xyz[valid]
    # Reference camera: orthographic [-1,1] horizontally, [-.1,1.9] vertically.
    v = (1.9 - points[:, 1]) / 2 * (height - 1)
    colours = []
    for sign, panel in zip([1, -1], panels):
        u = (.5 + sign * points[:, 0] / 2) * (height - 1)
        # Align the generated turquoise eyes to the production eye pivots (1.6696 m).
        source_v = v + (height * .0069 * np.exp(-((points[:, 1] - 1.67) / .045) ** 2) if sign == 1 else 0)
        colours.append(np.stack([map_coordinates(panel[:, :, c], [source_v, u], order=1, mode='nearest') for c in range(3)], axis=-1).astype(float))
    # The 1024-square close-up uses the reference's [-.16,.16] × [1.49,1.81] camera.
    fu = (points[:, 0] + .16) / .32 * (face_size - 1)
    fv = face_v(points[:, 1])
    face_colour = np.stack([map_coordinates(extended_face[:, :, c], [fv, fu], order=1, mode='nearest') for c in range(3)], axis=-1)
    face_blend = np.clip((points[:, 1] - 1.53) / .035, 0, 1)[:, None]
    colours[0] = colours[0] * (1 - face_blend) + face_colour * face_blend
    # Back/side scalp has no facial markings; do not inherit the old sheet's painted head shadows.
    scalp_colour = face[int(face_size * .24):int(face_size * .28), int(face_size * .47):int(face_size * .53)].mean(axis=(0, 1))
    colours[1] = colours[1] * (1 - face_blend) + scalp_colour * face_blend
    blend = np.clip(.5 + normal[valid, 2] * 1.5, 0, 1)[:, None]
    pixels = np.zeros((size, size, 4), dtype=np.uint8)
    pixels[valid, :3] = np.rint(colours[0] * blend + colours[1] * (1 - blend)).astype(np.uint8)
    pixels[:, :, 3] = 255
    # UV gutters retain the nearest island colour through bilinear/mipmap filtering.
    nearest = distance_transform_edt(~valid, return_distances=False, return_indices=True)
    pixels = pixels[tuple(nearest)]
    assert valid.sum() > size * size * .3 and np.unique(pixels.reshape(-1, 4), axis=0).shape[0] > 1000
    output = ROOT / 'public/models/skins/ssj-body.png'
    output.write_bytes(surface.png(size, size, pixels))
    # Reuse the same generated artwork for the separate eyeball surfaces.
    ex, ey = np.meshgrid(np.linspace(-.07, .07, 1024), np.linspace(1.71, 1.63, 512))
    eu = (ex + .16) / .32 * (face_size - 1)
    ev = face_v(ey)
    eye_pixels = np.stack([map_coordinates(face[:, :, c], [ev, eu], order=1, mode='nearest') for c in range(3)], axis=-1)
    Image.fromarray(eye_pixels).save(ROOT / 'public/models/skins/ssj-eyes.png')
    print(f'{output.name}: {size}x{size}, {valid.sum()} surface texels')


if __name__ == '__main__':
    bake()
