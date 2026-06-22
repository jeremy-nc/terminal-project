/**
 * Whole-app UI animation ("FX") types.
 *
 * Two flavours, both rendered by <AppFx/>:
 *   - Layer FX: a root-element class (e.g. screen shake) + a stack of overlay
 *     divs animated by CSS keyframes (see "anime-flash").
 *   - Component FX: a custom React renderer (canvas/JS), registered in
 *     AppFx.jsx's FX_COMPONENTS (see "cursor-orbs").
 *
 * Effects are independent and composable: VIEW_FX maps a view to ONE type or an
 * ARRAY of types, so opening a view can fire a combination. Trigger imperatively
 * with playAppFx(type); several can run at once.
 */
export const APP_FX_TYPES = {
  // Action-anime "impact frame": white double-flash, radiating speed lines, an
  // expanding shockwave ring, and a quick screen shake. (Layer FX.)
  "anime-flash": {
    duration: 950,
    rootClass: "fx-shake",
    layers: ["appfx-flash", "appfx-lines", "appfx-burst"],
  },
  // Glowing orbs spun clockwise out of the cursor, following it as it moves.
  // (Component FX — rendered by CursorOrbs on a canvas.)
  "cursor-orbs": {
    duration: 2400,
  },
  // Heavy nightclub/warehouse-rave smoke machine: full-screen volumetric haze
  // (WebGL fbm fog, rendered by RaveSmoke). One-shot over `duration` — the
  // component ramps density up FAST, holds heavy, then dissipates SLOWLY before
  // auto-removal. (Component FX.)
  "rave-smoke": {
    duration: 15000,
  },
};

/** Which FX fire when a view opens — a single type or a combination (array). */
export const VIEW_FX = {
  pulls: ["anime-flash", "cursor-orbs"],
  cicd: "rave-smoke",
};
