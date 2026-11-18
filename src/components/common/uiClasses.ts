/**
 * D3.0 canonical UI class strings (Nebula monochrome tokens only). New UI imports from
 * here; the per-file copies in CapstoneModal / BookDetailView / ErrorFallback etc. are
 * migrated in CD Batch 5 (zero visual change). `disabled:opacity-50` is reconciled into
 * every button style.
 */
export const BTN_PRIMARY =
  'h-11 sm:h-9 min-w-11 sm:min-w-0 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 inline-flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50';
export const BTN_SECONDARY =
  'h-11 sm:h-9 min-w-11 sm:min-w-0 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary inline-flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50';
export const BTN_TERTIARY =
  'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground disabled:opacity-50';
/**
 * Destructive confirm (dialog footers only): reuses the existing Log out style, never solid
 * red. Already dialog-sized (h-11 mobile / h-10 desktop, text-body) — do not append BTN_SIZE_LG.
 */
export const BTN_DESTRUCTIVE =
  'h-11 sm:h-10 min-w-11 sm:min-w-0 px-4 rounded-[10px] bg-negative/10 hover:bg-negative/20 border border-negative/30 text-body font-semibold text-negative inline-flex items-center justify-center whitespace-nowrap disabled:opacity-50';
/**
 * Dialog-footer size modifier for BTN_PRIMARY / BTN_SECONDARY: `${BTN_SECONDARY} ${BTN_SIZE_LG}`.
 * Only height/padding (sm:h-10 / px-4 sort after sm:h-9 / px-3.5 in Tailwind's output, so they win);
 * the text size is unchanged.
 */
export const BTN_SIZE_LG = 'h-11 sm:h-10 px-4';
/** Tertiary link with negative text (e.g. "Delete Forever…"). */
export const BTN_TERTIARY_NEGATIVE =
  'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center gap-1 text-label font-medium text-negative hover:underline disabled:opacity-50';
/**
 * CD D1.1: 16px on phones (no iOS focus zoom), 14px from 640px. index.css also enforces the
 * 16px floor for every form control < 640px, whatever its own text class.
 */
export const INPUT =
  'w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40';
export const TEXTAREA =
  'w-full p-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y';
export const HELPER = 'text-label text-muted-foreground';
export const FIELD_LABEL = 'block text-eyebrow uppercase text-muted-foreground';
export const EYEBROW = 'text-eyebrow uppercase text-muted-foreground';
export const CARD = 'bg-card border border-border rounded-[14px] p-5';
export const INSET = 'rounded-[10px] bg-surface2/70 border border-border p-3';
/** ux_spec_cd §0.4 keyboard hint chip. */
export const KBD =
  'px-1.5 py-0.5 rounded-[6px] bg-surface2 border border-border font-mono text-[11px] text-muted-foreground';
