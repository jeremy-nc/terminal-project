/** Tiny base64 helpers for the WebSocket binary protocol. */
export const b64enc = (bytes) =>
  btoa(String.fromCharCode(...bytes));

export const b64dec = (str) =>
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

/** Encode a plain string (e.g. a keystroke sequence) as base64. */
export const strToB64 = (str) =>
  btoa(unescape(encodeURIComponent(str)));
