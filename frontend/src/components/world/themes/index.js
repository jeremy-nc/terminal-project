import tropical from "./tropical.js";
import office from "./office.js";

export const THEMES = { tropical, office };
export const themeList = [
  { id: "tropical", label: "Tropical Island" },
  { id: "office", label: "Retro Cubicles" },
];
export function getTheme(id) { return THEMES[id] || tropical; }
