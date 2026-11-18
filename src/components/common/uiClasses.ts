/**
 * D3.0 canonical UI class strings (Nebula monochrome tokens only). New UI imports from
 * here; the per-file copies in CapstoneModal / BookDetailView / ErrorFallback etc. are
 * migrated in CD Batch 5 (zero visual change). `disabled:opacity-50` is reconciled into
 * every button style.
 */
export const BTN_PRIMARY =
  'h-9 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50';
export const BTN_SECONDARY =
  'h-9 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50';
export const BTN_TERTIARY =
  'inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground disabled:opacity-50';
/**
 * Destructive confirm (dialog footers only): reuses the existing Log out style, never solid
 * red. Already dialog-sized (h-10, text-body) — do not append BTN_SIZE_LG.
 */
export const BTN_DESTRUCTIVE =
  'h-10 px-4 rounded-[10px] bg-negative/10 hover:bg-negative/20 border border-negative/30 text-body font-semibold text-negative disabled:opacity-50';
/**
 * Dialog-footer size modifier for BTN_PRIMARY / BTN_SECONDARY: `${BTN_SECONDARY} ${BTN_SIZE_LG}`.
 * Only height/padding (h-10 / px-4 sort after h-9 / px-3.5 in Tailwind's output, so they win);
 * the text size is unchanged.
 */
export const BTN_SIZE_LG = 'h-10 px-4';
/** Tertiary link with negative text (e.g. "Delete Forever…"). */
export const BTN_TERTIARY_NEGATIVE =
  'inline-flex items-center gap-1 text-label font-medium text-negative hover:underline disabled:opacity-50';
export const INPUT =
  'w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40';
export const TEXTAREA =
  'w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y';
export const HELPER = 'text-label text-muted-foreground';
export const FIELD_LABEL = 'block text-eyebrow uppercase text-muted-foreground';
export const EYEBROW = 'text-eyebrow uppercase text-muted-foreground';
export const CARD = 'bg-card border border-border rounded-[14px] p-5';
export const INSET = 'rounded-[10px] bg-surface2/70 border border-border p-3';
