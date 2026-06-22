import React from "react";
import { createPortal } from "react-dom";
import { APP_FX_TYPES } from "../appFx.js";
import CursorOrbs from "./CursorOrbs.jsx";
import RaveSmoke from "./RaveSmoke.jsx";

// Component-FX renderers (canvas/JS). Layer-FX (CSS) fall through to the overlay.
const FX_COMPONENTS = {
  "cursor-orbs": CursorOrbs,
  "rave-smoke": RaveSmoke,
};

/** Renders one active whole-app FX, portaled to <body> so it always overlays the
 *  UI regardless of stacking contexts / the root's transient transform. App maps
 *  over the active set and keys each by fx.key, so re-triggering remounts. */
export default function AppFx({ fx }) {
  if (!fx) return null;
  const cfg = APP_FX_TYPES[fx.type];
  if (!cfg) return null;

  const Comp = FX_COMPONENTS[fx.type];
  const content = Comp ? (
    <Comp duration={cfg.duration} />
  ) : (
    <div className={`appfx-overlay ${fx.type}`}>
      {(cfg.layers || []).map((c) => <div key={c} className={c} />)}
    </div>
  );
  return createPortal(content, document.body);
}
