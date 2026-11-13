// Stroke icons, 24px grid, 1.75 stroke — drawn for this app.
import type { SVGProps } from "react";

const I = (d: string) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d={d} />
  </svg>
);

export const IconToday = I("M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 7v5l3 2");
export const IconTrends = I("M4 19h16M6 15l4-5 3 3 5-7");
export const IconJournal = I("M6 4h10a2 2 0 0 1 2 2v14l-3-2-3 2-3-2-3 2V6a2 2 0 0 1 2-2zM9 9h6M9 13h4");
export const IconStrap = I("M9 3h6l1 4v10l-1 4H9l-1-4V7zM8 9h8M8 15h8");
export const IconMore = I("M5 12h.01M12 12h.01M19 12h.01");
export const IconSettings = I("M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z");
export const IconLeft = I("M15 18l-6-6 6-6");
export const IconRight = I("M9 18l6-6-6-6");
export const IconHeart = I("M20.8 8.6a5 5 0 0 0-8.8-3.2a5 5 0 0 0-8.8 3.2c0 5.3 8.8 10.4 8.8 10.4s8.8-5.1 8.8-10.4z");
export const IconMoon = I("M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z");
export const IconWind = I("M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7");
export const IconBolt = I("M13 3L5 13h6l-1 8 8-10h-6z");
export const IconPlus = I("M12 5v14M5 12h14");
export const IconSync = I("M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3M5 4v4h4M19 20v-4h-4");
export const IconClose = I("M6 6l12 12M18 6L6 18");
export const IconBell = I("M6 9a6 6 0 1 1 12 0c0 5 2 7 2 7H4s2-2 2-7M10 20a2 2 0 0 0 4 0");

export const BrandMark = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="42 15" strokeLinecap="round" transform="rotate(-90 12 12)" />
  </svg>
);
