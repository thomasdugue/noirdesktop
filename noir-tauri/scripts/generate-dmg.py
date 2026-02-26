#!/usr/bin/env python3
"""
Génère le DMG Noir avec fenêtre personnalisée.
Branding landing page : Geist Mono, #000, minimaliste.
"""

import os
import sys
import subprocess
import shutil
import tempfile

# ─── Config ───────────────────────────────────────────────────────────────────
APP_PATH   = os.path.expanduser(
    "~/Documents/Thomas/noirdesktop/noir-tauri/src-tauri/target/release/bundle/macos/Noir.app"
)
ICON_PATH  = os.path.expanduser(
    "~/Documents/Thomas/noir logo/Mac/256.png"
)
OUT_DMG    = os.path.expanduser(
    "~/Documents/Thomas/noirdesktop/noir-tauri/src-tauri/target/release/bundle/dmg/Noir_0.1.0_aarch64.dmg"
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

    # ── Base noire + glow via numpy (rapide) ──
    arr = np.zeros((H, W, 3), dtype=np.uint8)

    # Glow elliptique centré
    y_c, x_c = np.mgrid[0:H, 0:W]
    dist = np.sqrt(((x_c - W/2) / (W / 1.6))**2 + ((y_c - H/2) / (H / 1.2))**2)
    glow_val = (np.exp(-dist * 2.2) * 12).astype(np.uint8)
    arr[:, :, 0] = glow_val
    arr[:, :, 1] = glow_val
    arr[:, :, 2] = glow_val

    # Grain rapide avec numpy
    rng = np.random.default_rng(42)
    noise = rng.integers(-4, 5, (H, W, 3), dtype=np.int16)
    arr = np.clip(arr.astype(np.int16) + noise, 0, 255).astype(np.uint8)

    img = Image.fromarray(arr, "RGB")
    draw = ImageDraw.Draw(img)

    # ── Arrow entre les icônes ──
    # Icônes à x=185 et x=515 → espace utile : 250 à 450
    ax0, ax1, ay = 258, 445, APP_ICON_Y
    ARROW_COL = (150, 150, 150)
    # Ligne principale
    draw.line([(ax0, ay), (ax1, ay)], fill=ARROW_COL, width=1)
    # Pointe de flèche
    tip = ax1
    draw.line([(tip - 12, ay - 7), (tip, ay)], fill=ARROW_COL, width=1)
    draw.line([(tip - 12, ay + 7), (tip, ay)], fill=ARROW_COL, width=1)

    # ── Textes ──
    try:
        from PIL import ImageFont
        fonts_to_try = [
            "/System/Library/Fonts/Menlo.ttc",
            "/System/Library/Fonts/Monaco.ttf",
            "/Library/Fonts/Courier New.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
        font_small = None
        font_title = None
        for fpath in fonts_to_try:
            if os.path.exists(fpath):
                font_small = ImageFont.truetype(fpath, 9)
                font_title = ImageFont.truetype(fpath, 11)
                break
        if font_small is None:
            font_small = ImageFont.load_default()
            font_title = font_small

        # "DRAG TO APPLICATIONS TO INSTALL" sous la flèche
        TEXT_COL  = (130, 130, 130)   # bien lisible sur fond noir
        for i, txt in enumerate(["DRAG TO APPLICATIONS", "TO INSTALL"]):
            bbox = draw.textbbox((0, 0), txt, font=font_small)
            tw = bbox[2] - bbox[0]
            tx = (W - tw) // 2
            draw.text((tx, ay + 14 + i * 13), txt, fill=TEXT_COL, font=font_small)

        # "N O I R" watermark en haut centré
        MARK_COL = (55, 55, 55)
        bbox = draw.textbbox((0, 0), "N O I R", font=font_title)
        tw = bbox[2] - bbox[0]
        tx = (W - tw) // 2
        draw.text((tx, 22), "N O I R", fill=MARK_COL, font=font_title)

        # "v0.1.0 beta" coin bas droit
        draw.text((W - 80, H - 20), "v0.1.0 beta", fill=(55, 55, 55), font=font_small)

    except Exception as e:
        print(f"   (texte PIL non disponible : {e})")

    out = "/tmp/noir_dmg_background.png"
    img.save(out, "PNG")
    print(f"✅ Background généré : {out}  ({W}×{H}px 1x)")
    return out

    # Wordmark "NOIR" ultra-discret en haut
    try:
        from PIL import ImageFont
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
        except:
            font = ImageFont.load_default()
        draw = ImageDraw.Draw(img)
        text = "N O I R"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        tx = (W - tw) // 2
        draw.text((tx, 44), text, fill=(255, 255, 255, 14), font=font)
    except Exception as e:
        pass  # Sans texte si font indispo

    # Instruction "Dépose Noir dans Applications" en bas
    try:
        draw = ImageDraw.Draw(img)
        inst = "Dépose Noir dans Applications pour l'installer"
        try:
            font_inst = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 24)
        except:
            font_inst = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), inst, font=font_inst)
        tw = bbox[2] - bbox[0]
        tx = (W - tw) // 2
        draw.text((tx, H - 88), inst, fill=(255, 255, 255, 46), font=font_inst)
    except:
        pass

    # Version
    try:
        draw = ImageDraw.Draw(img)
        try:
            font_v = ImageFont.truetype("/System/Library/Fonts/Courier.ttc", 18)
        except:
            font_v = ImageFont.load_default()
        draw.text((W - 108, H - 48), "v0.1.0 beta", fill=(255, 255, 255, 26), font=font_v)
    except:
        pass

    # Convertir en RGB pour PNG final
    bg = img.convert("RGB")
    out = "/tmp/noir_dmg_background.png"
    bg.save(out, "PNG")
    print(f"✅ Background généré : {out}  ({W}×{H}px @2x)")
    return out


# ─── 2. Créer le DMG avec background + AppleScript ────────────────────────────
def build_dmg(bg_path):
    staging = tempfile.mkdtemp(prefix="noir_dmg_")
    rw_dmg  = "/tmp/noir_rw.dmg"
    vol_name = "Noir"

    try:
        print("📦 Préparation du staging...")
        # Copier l'app
        app_dest = os.path.join(staging, "Noir.app")
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
        set position of item "Noir.app" of container window to {{{APP_ICON_X}, {APP_ICON_Y}}}
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
    print("🖤 Noir DMG Builder\n")

    if not os.path.exists(APP_PATH):
        print(f"❌ App introuvable : {APP_PATH}")
        sys.exit(1)

    bg = generate_background()
    build_dmg(bg)
    print("\n🎉 Terminé !")
