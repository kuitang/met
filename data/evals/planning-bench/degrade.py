import json, math, random
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter

random.seed(42)
objs = json.load(open("objects.json"))

def visitor_photo(src, dst):
    """Simulate a museum visitor's phone photo: perspective, rotation, dim warm light, glare, noise, jpeg."""
    im = Image.open(src).convert("RGB")
    im.thumbnail((1000, 1000))
    w, h = im.size
    # paste onto a wall-colored background (photo includes surroundings)
    bg = Image.new("RGB", (int(w*1.25), int(h*1.25)), (168, 160, 150))
    bg.paste(im, (int(w*0.12), int(h*0.1)))
    im = bg
    # rotate slightly
    im = im.rotate(random.uniform(-6, 6), expand=True, fillcolor=(120, 115, 108), resample=Image.BICUBIC)
    # perspective squeeze via quad transform
    w, h = im.size
    dx = int(w * 0.06)
    im = im.transform((w, h), Image.QUAD, (dx, 0, 0, h, w, h, w - dx, int(dx*0.4)), resample=Image.BICUBIC)
    # museum lighting: dimmer, warmer, lower contrast
    im = ImageEnhance.Brightness(im).enhance(0.82)
    im = ImageEnhance.Color(im).enhance(0.9)
    im = ImageEnhance.Contrast(im).enhance(0.88)
    # glare blob (glass reflection)
    glare = Image.new("L", im.size, 0)
    gd = ImageDraw.Draw(glare)
    gx, gy = int(w*random.uniform(0.25,0.7)), int(h*random.uniform(0.2,0.5))
    gd.ellipse([gx, gy, gx+int(w*0.3), gy+int(h*0.18)], fill=70)
    glare = glare.filter(ImageFilter.GaussianBlur(40))
    white = Image.new("RGB", im.size, (255, 250, 235))
    im = Image.composite(white, im, glare)
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    im.thumbnail((900, 900))
    im.save(dst, "JPEG", quality=68)

FONTS = "/usr/share/fonts/truetype/liberation/"
def label_image(o, dst):
    """Render a Met-style wall label, then photograph-degrade it."""
    W, H = 1400, 800
    im = Image.new("RGB", (W, H), (245, 243, 238))
    d = ImageDraw.Draw(im)
    artist_f = ImageFont.truetype(FONTS+"LiberationSans-Bold.ttf", 54)
    title_f  = ImageFont.truetype(FONTS+"LiberationSans-Italic.ttf", 48)
    body_f   = ImageFont.truetype(FONTS+"LiberationSans-Regular.ttf", 36)
    small_f  = ImageFont.truetype(FONTS+"LiberationSans-Regular.ttf", 30)
    y = 60
    if o["artist"]:
        d.text((70, y), o["artist"], font=artist_f, fill=(25,25,25)); y += 85
    for line in [o["title"][:55], (o["title"][55:110] or None)]:
        if line: d.text((70, y), line, font=title_f, fill=(25,25,25)); y += 70
    d.text((70, y), o["date"] or "", font=body_f, fill=(40,40,40)); y += 65
    d.text((70, y), o["medium"][:70], font=body_f, fill=(40,40,40)); y += 65
    d.text((70, y), o["credit"][:75], font=small_f, fill=(70,70,70)); y += 55
    d.text((70, y), "Accession Number: " + o["accession"], font=small_f, fill=(70,70,70))
    # photograph it: angle + dim + blur + shadow gradient
    im = im.rotate(random.uniform(-7, 7), expand=True, fillcolor=(130,125,118), resample=Image.BICUBIC)
    w2, h2 = im.size
    dx = int(w2*0.08)
    im = im.transform((w2, h2), Image.QUAD, (0, dx, dx, h2, w2, h2 - int(dx*0.5), w2 - dx, 0), resample=Image.BICUBIC)
    shadow = Image.new("L", im.size, 0)
    sd = ImageDraw.Draw(shadow)
    for i in range(im.size[0]):
        sd.line([(i,0),(i,im.size[1])], fill=int(60*i/im.size[0]))
    dark = ImageEnhance.Brightness(im).enhance(0.6)
    im = Image.composite(dark, im, shadow)
    im = ImageEnhance.Brightness(im).enhance(0.85)
    im = im.filter(ImageFilter.GaussianBlur(0.8))
    im.thumbnail((1100, 1100))
    im.save(dst, "JPEG", quality=70)

for o in objs:
    visitor_photo(f"images/{o['objectID']}_orig.jpg", f"images/{o['objectID']}_photo.jpg")
# labels for 8 objects (mix famous/obscure)
label_ids = [436535, 11417, 544442, 24423, 40681, 250684, 325329, 74832]
for o in objs:
    if o["objectID"] in label_ids:
        label_image(o, f"labels/{o['objectID']}_label.jpg")
print("degraded photos:", len(objs), "| labels:", len(label_ids))
