#!/usr/bin/env python3
"""
Génère le DMG Hean avec fenêtre personnalisée.
Branding landing page : Geist Mono, #000, minimaliste.
"""

import os
import sys
import subprocess
import shutil
import tempfile

# ─── Config ───────────────────────────────────────────────────────────────────
APP_PATH   = os.path.expanduser(
    "~/Documents/Thomas/noirdesktop/noir-tauri/src-tauri/target/release/bundle/macos/Hean.app"
)
ICON_PATH  = os.path.expanduser(
    "~/Documents/Thomas/noirdesktop/noir-tauri/src-tauri/icons/icon.png"
)
OUT_DMG    = os.path.expanduser(
    "~/Documents/Thomas/noirdesktop/noir-tauri/src-tauri/target/release/bundle/dmg/Hean_0.2.0-beta.1_aarch64.dmg"
)

# Taille de la fenêtre DMG en points (1x — corrige la troncature)
WIN_W = 700
WIN_H = 390

# Positions des icônes (centre de l'icône, en points)
APP_ICON_X   = 185
APP_ICON_Y   = 170
APPS_ICON_X  = 515
APPS_ICON_Y  = 170

# ─── 1. Générer le background PNG (1x, 700×390) ───────────────────────────────
def generate_background():
    try:
        from PIL import Image, ImageDraw
        import numpy as np
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "pillow", "numpy", "-q"], check=True)
        from PIL import Image, ImageDraw
        import numpy as np

    # 1x — Finder affiche le PNG à la taille réelle en points
    W, H = WIN_W, WIN_H  # 700 × 390

    # ── Base noire + dual glow (profondeur 2026) ──
    arr = np.zeros((H, W, 3), dtype=np.uint8)
    y_c, x_c = np.mgrid[0:H, 0:W]

    # Glow 1 — large, très subtil (ambiance)
    dist1 = np.sqrt(((x_c - W/2) / (W / 1.6))**2 + ((y_c - H/2) / (H / 1.2))**2)
    glow1 = (np.exp(-dist1 * 2.0) * 10).astype(np.uint8)

    # Glow 2 — concentré, légèrement plus fort (focus central)
    dist2 = np.sqrt(((x_c - W/2) / (W / 3.0))**2 + ((y_c - H*0.45) / (H / 2.0))**2)
    glow2 = (np.exp(-dist2 * 1.8) * 8).astype(np.uint8)

    combined = np.clip(glow1.astype(np.int16) + glow2.astype(np.int16), 0, 255).astype(np.uint8)
    arr[:, :, 0] = combined
    arr[:, :, 1] = combined
    arr[:, :, 2] = combined

    # Grain texturé (plus prononcé pour le côté tactile 2026)
    rng = np.random.default_rng(42)
    noise = rng.integers(-6, 7, (H, W, 3), dtype=np.int16)
    arr = np.clip(arr.astype(np.int16) + noise, 0, 255).astype(np.uint8)

    img = Image.fromarray(arr, "RGB")
    draw = ImageDraw.Draw(img)

    # ── Flèche pointillée entre les icônes ──
    ax0, ax1, ay = 258, 445, APP_ICON_Y
    ARROW_COL = (100, 100, 100)
    dash_len, gap_len = 6, 4
    x = ax0
    while x < ax1 - 15:
        draw.line([(x, ay), (min(x + dash_len, ax1 - 15), ay)], fill=ARROW_COL, width=1)
        x += dash_len + gap_len
    tip = ax1
    draw.line([(tip - 10, ay - 5), (tip, ay)], fill=ARROW_COL, width=1)
    draw.line([(tip - 10, ay + 5), (tip, ay)], fill=ARROW_COL, width=1)

    # ── Textes ──
    try:
        from PIL import ImageFont
        fonts_mono = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf"]
        fonts_sans = ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNSText.ttf"]
        font_small = font_title = font_badge = None
        for fpath in fonts_mono:
            if os.path.exists(fpath):
                font_small = ImageFont.truetype(fpath, 9)
                font_badge = ImageFont.truetype(fpath, 7)
                break
        for fpath in fonts_sans:
            if os.path.exists(fpath):
                font_title = ImageFont.truetype(fpath, 11)
                break
        if not font_small:
            font_small = ImageFont.load_default()
        if not font_title:
            font_title = font_small
        if not font_badge:
            font_badge = font_small

        # Instruction sous la flèche
        TEXT_COL = (110, 110, 110)
        for i, txt in enumerate(["D R A G   T O   A P P L I C A T I O N S", "T O   I N S T A L L"]):
            bbox = draw.textbbox((0, 0), txt, font=font_badge)
            tw = bbox[2] - bbox[0]
            draw.text(((W - tw) // 2, ay + 16 + i * 12), txt, fill=TEXT_COL, font=font_badge)

        # "H E A N" watermark haut centré
        MARK_COL = (40, 40, 40)
        bbox = draw.textbbox((0, 0), "H  E  A  N", font=font_title)
        tw = bbox[2] - bbox[0]
        draw.text(((W - tw) // 2, 20), "H  E  A  N", fill=MARK_COL, font=font_title)

        # Badges formats en bas à gauche
        BADGE_COL = (35, 35, 35)
        badges = "F L A C    A L A C    W A V    A I F F    2 4 - B I T"
        draw.text((20, H - 18), badges, fill=BADGE_COL, font=font_badge)

        # Version bas à droite
        ver = "v 0 . 2 . 0 - b e t a . 1"
        bbox = draw.textbbox((0, 0), ver, font=font_badge)
        tw = bbox[2] - bbox[0]
        draw.text((W - tw - 20, H - 18), ver, fill=BADGE_COL, font=font_badge)

    except Exception as e:
        print(f"   (texte PIL non disponible : {e})")

    out = "/tmp/hean_dmg_background.png"
    img.save(out, "PNG")
    print(f"✅ Background généré : {out}  ({W}×{H}px 1x)")
    return out


# ─── 2. Créer le DMG avec background + AppleScript ────────────────────────────
def build_dmg(bg_path):
    staging = tempfile.mkdtemp(prefix="hean_dmg_")
    rw_dmg  = "/tmp/hean_rw.dmg"
    vol_name = "Hean"

    try:
        print("📦 Préparation du staging...")
        # Copier l'app
        app_dest = os.path.join(staging, "Hean.app")
        if os.path.exists(app_dest):
            shutil.rmtree(app_dest)
        shutil.copytree(APP_PATH, app_dest)

        # Symlink Applications
        apps_link = os.path.join(staging, "Applications")
        if os.path.exists(apps_link):
            os.remove(apps_link)
        os.symlink("/Applications", apps_link)

        # Dossier background (hidden)
        bg_dir = os.path.join(staging, ".background")
        os.makedirs(bg_dir, exist_ok=True)
        shutil.copy(bg_path, os.path.join(bg_dir, "background.png"))

        # Créer DMG inscriptible
        print("💿 Création du DMG inscriptible...")
        if os.path.exists(rw_dmg):
            os.remove(rw_dmg)
        subprocess.run([
            "hdiutil", "create",
            "-volname", vol_name,
            "-srcfolder", staging,
            "-ov", "-format", "UDRW",
            rw_dmg
        ], check=True, capture_output=True)

        # Monter le DMG
        print("🔧 Montage du DMG...")
        result = subprocess.run(
            ["hdiutil", "attach", rw_dmg, "-readwrite", "-noverify", "-noautoopen"],
            check=True, capture_output=True, text=True
        )
        # Trouver le point de montage
        mount_point = None
        for line in result.stdout.split("\n"):
            if "/Volumes/" in line:
                parts = line.split("\t")
                mount_point = parts[-1].strip()
                break

        if not mount_point:
            raise RuntimeError("Impossible de trouver le point de montage")
        print(f"   Monté sur : {mount_point}")

        # Chemin POSIX vers le background dans le volume monté
        bg_in_vol = os.path.join(mount_point, ".background", "background.png")
        # Nom du volume (ex: "Noir" depuis "/Volumes/Noir")
        disk_name = os.path.basename(mount_point)

        # AppleScript — utilise le nom du volume directement
        applescript = f"""
tell application "Finder"
    tell disk "{disk_name}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {{200, 100, {200 + WIN_W}, {100 + WIN_H}}}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 88
        set background picture of viewOptions to (POSIX file "{bg_in_vol}") as alias
        set position of item "Hean.app" of container window to {{{APP_ICON_X}, {APP_ICON_Y}}}
        set position of item "Applications" of container window to {{{APPS_ICON_X}, {APPS_ICON_Y}}}
        close
        open
        update without registering applications
        delay 4
        close
    end tell
end tell
"""
        print("🎨 Application du style via AppleScript...")
        result = subprocess.run(["osascript", "-e", applescript], capture_output=True, text=True)
        if result.returncode != 0:
            print(f"⚠️  AppleScript warning: {result.stderr.strip()}")
        else:
            print("   ✓ Style appliqué")

        # Démonter
        import time
        time.sleep(2)
        print("📤 Démontage...")
        subprocess.run(["hdiutil", "detach", mount_point, "-force"], check=True, capture_output=True)

        # Convertir en DMG compressé final
        print("🗜  Compression du DMG final...")
        os.makedirs(os.path.dirname(OUT_DMG), exist_ok=True)
        if os.path.exists(OUT_DMG):
            os.remove(OUT_DMG)
        subprocess.run([
            "hdiutil", "convert", rw_dmg,
            "-format", "UDZO",
            "-imagekey", "zlib-level=9",
            "-o", OUT_DMG
        ], check=True, capture_output=True)

        # Cleanup
        os.remove(rw_dmg)
        size_mb = os.path.getsize(OUT_DMG) / 1_048_576
        print(f"\n✅ DMG final : {OUT_DMG}")
        print(f"   Taille : {size_mb:.1f} MB")

    finally:
        shutil.rmtree(staging, ignore_errors=True)


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("🖤 Hean DMG Builder\n")

    if not os.path.exists(APP_PATH):
        print(f"❌ App introuvable : {APP_PATH}")
        sys.exit(1)

    bg = generate_background()
    build_dmg(bg)
    print("\n🎉 Terminé !")
