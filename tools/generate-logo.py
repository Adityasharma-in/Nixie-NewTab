"""Nixie New Tab logo generator — modern lab-instrument mark.

Concept: single vertical glass capsule centered on a blackened-steel
squircle badge, plasma-orange N filament (Nixie / New-tab), steel collar
base, underglow pool. Tuned so the N stays legible down to 16px.
"""
from PIL import Image, ImageDraw, ImageFilter

CHASSIS_TOP = (38, 41, 48)
CHASSIS_BOT = (10, 11, 14)
PLASMA = (255, 138, 0)
PLASMA_DIGIT = (255, 154, 31)
PLASMA_CORE = (255, 194, 122)
HOT = (255, 226, 184)

SIZE = 1024
CX = SIZE // 2


def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        line = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = line
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def capsule_mask(w, h, radius):
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    return m


def draw_n(draw, x0, y0, x1, y1, fill, width):
    draw.line([(x0, y0), (x0, y1)], fill=fill, width=width, joint="curve")
    draw.line([(x0, y1), (x1, y0)], fill=fill, width=width, joint="curve")
    draw.line([(x1, y0), (x1, y1)], fill=fill, width=width, joint="curve")


def build_master(size=1024):
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    s = size / 1024.0

    # --- chassis badge ---
    radius = int(232 * s)
    grad = vgrad(size, size, CHASSIS_TOP, CHASSIS_BOT).convert("RGBA")
    grad.putalpha(rounded_mask(size, radius))
    base.alpha_composite(grad)

    d = ImageDraw.Draw(base)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius,
                        outline=(180, 185, 192, 70), width=max(2, int(4 * s)))
    d.rounded_rectangle([int(28 * s), int(28 * s), size - int(28 * s), size - int(28 * s)],
                        radius=int(204 * s), outline=(255, 255, 255, 18),
                        width=max(2, int(2 * s)))

    # faint warm ambient at top so badge never reads pure black
    amb = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(amb)
    ad.ellipse([CX - int(360 * s), -int(260 * s), CX + int(360 * s), int(340 * s)],
               fill=(255, 138, 0, 22))
    amb = amb.filter(ImageFilter.GaussianBlur(int(60 * s)))
    base.alpha_composite(amb)

    # --- underglow pool beneath tube ---
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([CX - int(320 * s), int(690 * s), CX + int(320 * s), int(960 * s)],
               fill=(255, 138, 0, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(int(60 * s)))
    base.alpha_composite(glow)

    # --- glass tube (wider + brighter than v1 for small-size legibility) ---
    tw, th = int(400 * s), int(620 * s)
    tx0, ty0 = CX - tw // 2, int(180 * s)
    trad = tw // 2
    glass_grad = vgrad(tw, th, (72, 78, 88), (16, 18, 22)).convert("RGBA")
    sheen_top = Image.new("RGBA", (tw, th), (255, 255, 255, 0))
    sd = ImageDraw.Draw(sheen_top)
    sd.ellipse([-tw // 2, -th // 3, tw + tw // 2, th // 3], fill=(255, 255, 255, 30))
    glass_grad.alpha_composite(sheen_top)
    glass_grad.putalpha(capsule_mask(tw, th, trad))
    base.alpha_composite(glass_grad, (tx0, ty0))

    gd2 = ImageDraw.Draw(base)
    gd2.rounded_rectangle([tx0, ty0, tx0 + tw, ty0 + th], radius=trad,
                          outline=(170, 176, 184, 90), width=max(3, int(6 * s)))
    gd2.line([(tx0 + int(56 * s), ty0 + int(90 * s)),
              (tx0 + int(56 * s), ty0 + th - int(90 * s))],
             fill=(255, 255, 255, 34), width=max(2, int(10 * s)))
    sheen = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shd = ImageDraw.Draw(sheen)
    shd.polygon([(tx0 + int(70 * s), ty0 + th), (tx0 + int(220 * s), ty0),
                 (tx0 + int(300 * s), ty0), (tx0 + int(150 * s), ty0 + th)],
                fill=(255, 255, 255, 18))
    base.alpha_composite(sheen)

    # --- anode pins ---
    pin_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pin_layer)
    x0, x1 = CX - int(110 * s), CX + int(110 * s)
    y0, y1 = int(340 * s), int(680 * s)
    for px_ in (x0, x1):
        pd.line([(px_, ty0 + int(30 * s)), (px_, y0)], fill=(150, 156, 164, 120),
                width=max(2, int(6 * s)))
        pd.line([(px_, y1), (px_, ty0 + th - int(96 * s))], fill=(150, 156, 164, 100),
                width=max(2, int(6 * s)))
    base.alpha_composite(pin_layer)

    # --- plasma N filament, layered for a bold modern glow ---
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    draw_n(hd, x0, y0, x1, y1, PLASMA + (150,), int(110 * s))
    halo = halo.filter(ImageFilter.GaussianBlur(int(48 * s)))
    base.alpha_composite(halo)

    mid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    md = ImageDraw.Draw(mid)
    draw_n(md, x0, y0, x1, y1, PLASMA_DIGIT + (255,), int(64 * s))
    mid = mid.filter(ImageFilter.GaussianBlur(int(14 * s)))
    base.alpha_composite(mid)

    core = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    draw_n(cd, x0, y0, x1, y1, PLASMA_CORE + (255,), int(40 * s))
    base.alpha_composite(core)

    hot = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd2 = ImageDraw.Draw(hot)
    draw_n(hd2, x0, y0, x1, y1, HOT + (255,), int(16 * s))
    base.alpha_composite(hot)

    # --- metal collar base ---
    cw, chh = int(300 * s), int(84 * s)
    cx0 = CX - cw // 2
    cy0 = ty0 + th - int(62 * s)
    collar = vgrad(cw, chh, (74, 79, 87), (18, 20, 24)).convert("RGBA")
    collar.putalpha(capsule_mask(cw, chh, int(22 * s)))
    base.alpha_composite(collar, (cx0, cy0))
    fd = ImageDraw.Draw(base)
    fd.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + chh], radius=int(22 * s),
                         outline=(255, 255, 255, 36), width=max(2, int(3 * s)))
    fd.line([(cx0 + int(22 * s), cy0 + int(15 * s)),
             (cx0 + cw - int(22 * s), cy0 + int(15 * s))],
            fill=(255, 255, 255, 30), width=max(2, int(3 * s)))

    return base


def save_icon(master, px, path):
    icon = master.resize((px, px), Image.LANCZOS)
    icon.save(path)


if __name__ == "__main__":
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons = os.path.join(root, "icons")
    os.makedirs(icons, exist_ok=True)
    master = build_master(1024)
    master.save(os.path.join(icons, "logo-master.png"))
    for px in (16, 32, 48, 128):
        save_icon(master, px, os.path.join(icons, f"icon{px}.png"))
    print("logo written to", icons)
