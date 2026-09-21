"""
generate_apple_icons.py — 工业级 Apple Squircle（超椭圆圆角）多 DPI 图标生成脚本
遵循 desktop-app-icon-mastery 规范：
- 4x 超采样（Supersampling）连续曲率平滑抗锯齿
- 16 / 24 / 32 / 48 / 64 / 128 / 256 完整七阶 Windows ICO 点阵
- 同步分发至 public/ 与构建输出目录
"""
from PIL import Image, ImageDraw
import os
import shutil

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_PNG = os.path.join(ROOT_DIR, 'app', 'ui', 'public', 'icon.png')
PUBLIC_DIR = os.path.join(ROOT_DIR, 'app', 'ui', 'public')

def create_apple_squircle_mask(size: int, radius_ratio: float = 0.224) -> Image.Image:
    """
    创建 4x 超采样抗锯齿 Apple-style 圆角矩形 / 超椭圆蒙版
    """
    scale = 4
    high_res_size = size * scale
    radius = int(high_res_size * radius_ratio)
    
    mask = Image.new("L", (high_res_size, high_res_size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        [(0, 0), (high_res_size - 1, high_res_size - 1)],
        radius=radius,
        fill=255
    )
    return mask.resize((size, size), Image.Resampling.LANCZOS)

def make_apple_icon(img: Image.Image, size: int) -> Image.Image:
    """
    将图像裁切为 Apple Squircle 风格（圆角外透明，主体占比 ~90% 黄金比例）
    """
    padding = max(1, int(size * 0.04))
    inner_size = size - padding * 2
    
    resized = img.resize((inner_size, inner_size), Image.Resampling.LANCZOS)
    mask = create_apple_squircle_mask(inner_size, radius_ratio=0.224)
    
    rounded_inner = Image.new("RGBA", (inner_size, inner_size), (0, 0, 0, 0))
    rounded_inner.paste(resized, (0, 0))
    rounded_inner.putalpha(mask)
    
    final_canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    final_canvas.paste(rounded_inner, (padding, padding), rounded_inner)
    return final_canvas

def main():
    if not os.path.exists(SRC_PNG):
        print(f"Error: {SRC_PNG} not found")
        return

    src_img = Image.open(SRC_PNG).convert("RGBA")
    print(f"Loaded master image: {src_img.size}")

    # 1. 生成 1024x1024 高清苹果风 PNG 母版
    master_1024 = make_apple_icon(src_img, 1024)
    master_512 = make_apple_icon(src_img, 512)
    master_256 = make_apple_icon(src_img, 256)

    # 2. 生成多阶分辨率帧 (16, 24, 32, 48, 64, 128, 256)
    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    ico_frames = [make_apple_icon(src_img, s) for s in ico_sizes]

    # 保存 ICO 文件
    ico_path = os.path.join(PUBLIC_DIR, 'icon.ico')
    ico_frames[0].save(
        ico_path,
        format='ICO',
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_frames[1:]
    )
    print(f"Generated multi-frame Windows ICO: {ico_path} with sizes {ico_sizes}")

    # 保存各 PNG 图标
    png_1024_path = os.path.join(PUBLIC_DIR, 'icon.png')
    png_256_path = os.path.join(PUBLIC_DIR, 'icon-square.png')
    splash_ico_path = os.path.join(PUBLIC_DIR, 'splash-icon.ico')
    splash_png_path = os.path.join(PUBLIC_DIR, 'splash-icon.png')

    master_1024.save(png_1024_path, format='PNG')
    master_256.save(png_256_path, format='PNG')
    master_512.save(splash_png_path, format='PNG')
    shutil.copyfile(ico_path, splash_ico_path)

    # 3. 同步到 dist-electron 与 dist (如果存在)
    for sub in ['dist-electron', 'dist']:
        target_dir = os.path.join(ROOT_DIR, 'app', 'ui', sub)
        if os.path.exists(target_dir):
            shutil.copyfile(ico_path, os.path.join(target_dir, 'icon.ico'))
            shutil.copyfile(png_1024_path, os.path.join(target_dir, 'icon.png'))
            shutil.copyfile(splash_ico_path, os.path.join(target_dir, 'splash-icon.ico'))
            shutil.copyfile(splash_png_path, os.path.join(target_dir, 'splash-icon.png'))
            print(f"Synced icons to {target_dir}")

    print("All Apple squircle icons generated successfully!")

if __name__ == '__main__':
    main()
