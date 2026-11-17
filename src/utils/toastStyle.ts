export type ToastType = 'success' | 'error' | 'info';

export interface ToastVisualStyle {
  variant: ToastType;
  containerClass: string;
  dotClass: string;
  actionClass: string;
}

/**
 * Semantic toast classification (M4.3).
 * Trusts the explicit caller-provided type — message text never overrides it,
 * so 'Captured "Failure Mode"' stays a success and 'Marked paused' stays neutral.
 */
export function classifyToast(type: ToastType | undefined | null): ToastType {
  if (type === 'success' || type === 'error' || type === 'info') return type;
  return 'info';
}

export function getToastStyle(type: ToastType | undefined | null): ToastVisualStyle {
  const variant = classifyToast(type);
  if (variant === 'error') {
    return {
      variant,
      containerClass: 'notification-error bg-rose-700/95 border-rose-400/40 text-white',
      dotClass: 'bg-white animate-pulse',
      actionClass:
        'bg-white/20 hover:bg-white/30 text-white focus-visible:ring-2 focus-visible:ring-white/70',
    };
  }
  if (variant === 'success') {
    return {
      variant,
      containerClass: 'notification-success bg-emerald-700/95 border-emerald-400/40 text-white',
      dotClass: 'bg-white animate-pulse',
      actionClass:
        'bg-white/20 hover:bg-white/30 text-white focus-visible:ring-2 focus-visible:ring-white/70',
    };
  }
  return {
    variant,
    containerClass: 'notification-info bg-popover border-border text-foreground',
    dotClass: 'bg-muted-foreground',
    actionClass:
      'border border-border bg-surface2 hover:bg-secondary text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
  };
}
