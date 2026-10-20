"""Tạo icon16/48/128.png (mũi tên tải xuống trên nền đỏ) bằng Pillow."""
from PIL import Image, ImageDraw

for size in (16, 48, 128):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size * 0.2
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=(229, 57, 53, 255))
    s = size
    # thân mũi tên
    d.rectangle((s * 0.42, s * 0.18, s * 0.58, s * 0.55), fill="white")
    # đầu mũi tên
    d.polygon([(s * 0.25, s * 0.52), (s * 0.75, s * 0.52), (s * 0.5, s * 0.75)], fill="white")
    # vạch đáy
    d.rectangle((s * 0.22, s * 0.8, s * 0.78, s * 0.88), fill="white")
    img.save(f"icon{size}.png")
print("ok")
