HELD — CLAY v5.1: ARTIST-READY EXPORTS

This update keeps the existing two-person video, gesture and sculpting logic.
The changes are only to submitted/downloaded files. It does not change Supabase rooms,
RLS policies or private storage access.

FILES TO REPLACE ON YOUR WORKING NETLIFY SITE:
- app.js
- index.html (only changes the DOWNLOAD button label; optional)
Keep YOUR OWN config.js, and keep style.css. Upload your whole working website folder.
DO NOT overwrite config.js from a previous download or rerun database.sql.

IMPORTANT: ONE-TIME SUPABASE STORAGE SETTING
Existing submissions bucket only permits image/png, image/svg+xml, application/json.
Before uploading TXT/STL/OBJ, in Supabase Dashboard -> Storage -> submissions -> Edit bucket,
expand Allowed MIME Types to include BOTH:
  text/plain
  model/stl
while RETAINING:
  image/png
  image/svg+xml
  application/json
Keep the bucket PRIVATE, not Public, and preserve the existing 10 MB size limit.
Do not loosen room RLS or add browser-side secret/service-role keys.

WHAT SUBMIT NOW SENDS:
held-words.txt           human readable Player A and Player B words, room/time & 3D size
held-clay-25mm.stl       same THREE.js deformed shape, proportional 25mm longest dimension
held-clay-25mm.obj       editable 3D mesh for Blender, same mm-size coordinates
clay-transparent.png    image of the model from the current viewpoint
clay-three-views.png    front / side / top references for hand sculpting
clay-outline.svg        TWO-D silhouette from current viewpoint, not 3D
clay-mesh-and-words.json complete exact vertex/deformation archive (for future editing)

DOWNLOAD also includes the same six assets in one ZIP.

STL is not automatically a printer-ready jewelry piece:
- Geometry preserves the digital sculpture's form up to proportional scaling.
- STL has no explicit units; load as mm, with 25mm largest dimension.
- STL stores neither color nor gem settings. Artist selects material/finish as a surprise.
- This initial clay shape is not itself a ring band or charm with loop/hole.
- Aggressive deformations can make surfaces self-intersect, even when source starts closed.
- Run mesh checks/repair and inspect in your slicer before printing (manifold, supports,
  minimum wall/cross-section thickness, base adhesion, connection and chosen final size).
- For hand sculpting, orbit the 3D preview and take front/side/top references; use
  the STL in Blender for precise multiple-angle views rather than relying on one PNG.

TEST:
1. First update the private submissions bucket's allowed MIME types as above.
2. Replace app.js and index.html in YOUR working website folder, retain config.js.
3. Re-upload the entire folder to Netlify; refresh devices and create a new room.
4. In console: window.HELD_EXPORT_BUILD -> 'held-words-txt-stl-obj-25mm-v51'
5. As both users save their words, download and submit. In Supabase Storage confirm
   seven files, including .txt and .stl; open .txt and try .stl in Blender/slicer.

STATUS:
JS static syntax checked. No live Supabase upload or cross-device printability test.
