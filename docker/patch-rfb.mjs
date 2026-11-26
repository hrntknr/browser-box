import fs from "node:fs";

const path = process.argv[2] ?? "/usr/share/novnc/core/rfb.js";
let source = fs.readFileSync(path, "utf8");

function apply(name, target, replacement) {
  if (!source.includes(target)) {
    console.error(`rfb.js patch target not found: ${name}`);
    process.exit(1);
  }
  source = source.replace(target, replacement);
}

// stock noVNC refuses SetDesktopSize while view-only; allow it so the resolution follows the viewer even before handover
apply(
  "view-only resize guard",
  `if (!this._resizeSession) {
            return;
        }
        if (this._viewOnly) {
            return;
        }`,
  `if (!this._resizeSession) {
            return;
        }`,
);

// Chrome windows cannot go below 508px wide, so floor the framebuffer width there and scale the height along to keep the viewer's aspect ratio; BB_FORCE_SIZE pins an exact size instead
apply(
  "framebuffer width floor",
  `        const size = this._screenSize();

        // Do we actually change anything?`,
  `        const size = this._screenSize();
        const minW = window.BB_MIN_FB_WIDTH || 508;
        if (size.w > 0 && size.w < minW) {
            size.h = Math.round(size.h * minW / size.w);
            size.w = minW;
        }
        if (window.BB_FORCE_SIZE) {
            size.w = window.BB_FORCE_SIZE.w;
            size.h = window.BB_FORCE_SIZE.h;
        }

        // Do we actually change anything?`,
);

fs.writeFileSync(path, source);
