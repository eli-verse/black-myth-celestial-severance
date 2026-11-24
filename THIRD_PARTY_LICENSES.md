# Third-Party Licenses

All third-party 3D models, animations, HDRI environment maps, and audio assets bundled under `public/assets/` are licensed under Creative Commons (`CC0-1.0` / `CC-BY-4.0`) for local showcase use, with upstream creator attributions preserved below.

| Asset File(s) | Upstream Asset & Pack | Author / Creator | License | Source URL | Notes |
|---|---|---|---|---|---|
| `public/assets/models/player/hero_wukong.glb` | Black Myth: Wukong - Sun Wu Kong (`2083617e233949d3b14fe4949d5b047c`) | hakudragons (Sketchfab) | `CC-BY-4.0` | https://sketchfab.com/3d-models/2083617e233949d3b14fe4949d5b047c | Pruned invisible proxy primitive via `@gltf-transform` |
| `public/assets/models/boss/boss_jiebo.glb` | Black Myth: Wukong - Mo Jiang Jie Bo [Animation] (`50fee8a2fa14497d9bba5ea3d914aa3b`) | hakudragons (Sketchfab) | `CC-BY-4.0` | https://sketchfab.com/3d-models/50fee8a2fa14497d9bba5ea3d914aa3b | Deduplicated via `@gltf-transform`; 18 embedded animations preserved |
| `public/assets/models/player/player_swordsman.glb` | Quaternius Universal Base Characters + Universal Animation Library 1 & 2 (`human_male.glb`) | Quaternius (merged via NafisRayan pipeline) | `CC0-1.0` | https://quaternius.com/ | Modified: pruned to 18 combat/locomotion clips, stripped constant child translation/scale tracks, compressed large textures to 1024px JPEG |
| `public/assets/models/player/weapon_katana.glb` | Grab3D Katana (`katana.glb`) | Grab3D | `CC0-1.0` | https://grab3d.com/license | Unmodified |
| `public/assets/models/boss/boss_titan.glb` | KayKit Character Pack: Skeletons 1.0 (`Skeleton_Warrior.glb`) + KayKit Character Animations 1.1 (`Rig_Medium_Special.glb`) | Kay Lousberg (`www.kaylousberg.com`) | `CC0-1.0` | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0 | Modified: merged `Skeletons_Taunt_Longer` animation clip onto `Skeleton_Warrior.glb` |
| `public/assets/models/boss/boss_weapon.glb` | Quaternius Ultimate RPG Pack (`Axe_Double_Golden.glb`) | Quaternius | `CC0-1.0` | https://quaternius.com/packs/ultimaterpg.html | Unmodified |
| `public/assets/models/env/column.glb`, `dragon_statue.glb`, `bell_structure.glb`, `arch_banner.glb`, `main_altar.glb` | Polygonal Mind Lunar Year Pack | Polygonal Mind (GLB via ToxSam) | `CC0-1.0` | https://github.com/ToxSam/cc0-models-Polygonal-Mind | Unmodified |
| `public/assets/models/env/column_broken.glb` | Quaternius Modular Dungeon Pack (`Column_Broken.glb`) | Quaternius | `CC0-1.0` | https://quaternius.com/packs/medievaldungeon.html | Unmodified |
| `public/assets/hdri/arena_night.hdr`, `arena_dusk.hdr` | `clarens_night_01_2k.hdr`, `dikhololo_sunset_2k.hdr` | Poly Haven | `CC0-1.0` | https://polyhaven.com/license | Unmodified 2K Radiance HDRI |
| `public/assets/audio/bgm/bgm_wuxia_overture.mp3`, `bgm_phase1_chant_rock.mp3`, `bgm_phase2_deity_choir.mp3`, `bgm_finisher_kengeki.mp3`, `bgm_victory_wuxia2.mp3` | `Wuxia3`, `EpicBattle_J`, `EpicBattle_Deity`, `Kengeki`, `Wuxia2` | PeriTune / Sei Mutsuki (`peritune.com`) | `CC-BY-4.0` | https://peritune.com/ | Unmodified 192 kbps stereo MP3 |
| `public/assets/audio/sfx/wukong_*.wav`, `meat_hit_*.wav` | Original Wukong Vocal Battle Cries & Heavy Impact SFX | First-Party Synthesized | `CC0-1.0` | Local first-party generation | Lossless 32kHz Stereo PCM |
| `public/assets/audio/bgm/bgm_phase1.ogg` | `asianoriental1.ogg` | Tozan (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/asianoriental1 | Unmodified fallback |
| `public/assets/audio/bgm/bgm_phase2.mp3` | `battleThemeA.mp3` | cynicmusic (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/battle-theme-a | Unmodified |
| `public/assets/audio/bgm/bgm_victory.ogg` | `fanfare1.ogg` | ARoachIFoundOnMyPillow (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/victory-fanfare | Unmodified |
| `public/assets/audio/sfx/sword_slash_1.wav`..`4.wav` | Swishes Sound Pack (`swish-1.wav`..`4.wav`) | artisticdude (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/swishes-sound-pack | Extracted from archive |
| `public/assets/audio/sfx/sword_heavy.wav` | 3 Melee Sounds (`sword sound.wav`) | Iwan Gabovitch (qubodup) & remaxim (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/3-melee-sounds | Extracted from archive |
| `public/assets/audio/sfx/boss_roar.m4a` | CC0 Deep Monster Roar (`monster_roar.wav`) | trazzz123 (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/cc0-deep-monster-roar | Transcoded from WAV to AAC `.m4a` via macOS `afconvert` |
| `public/assets/audio/sfx/boss_roar_2.ogg` | Big scary troll sounds (`troll-roars.ogg`) | Darsycho (OpenGameArt) | `CC0-1.0` | https://opengameart.org/content/big-scary-troll-sounds | Unmodified |
| `public/assets/audio/sfx/knife_slice_1.ogg`, `knife_slice_2.ogg`, `impact_heavy_1.ogg`, `impact_heavy_2.ogg`, `impact_metal_1.ogg`, `impact_metal_2.ogg`, `dodge_cloth_1.ogg`, `dodge_cloth_2.ogg`, `chime_bell.ogg`, `gong_heavy.ogg`, `posture_break.ogg` | Kenney Impact Sounds & RPG Audio | Kenney (`kenney.nl`) | `CC0-1.0` | https://kenney.nl/assets | Unmodified `.ogg` |

## License Text

Creative Commons Zero v1.0 Universal (CC0-1.0):
https://creativecommons.org/publicdomain/zero/1.0/

Creative Commons Attribution 4.0 International (CC-BY-4.0):
https://creativecommons.org/licenses/by/4.0/
