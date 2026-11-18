import React, { useEffect } from 'react';
import { Toaster } from 'sonner';

/** CD D1.1: with `viewport-fit=cover`, the root pads the notch / rounded-corner insets. */
export function AppLayout({ children }: { children: React.ReactNode }) {
  // CD D2.3 / ux_spec_cd §D.4.2: temporarily open collapsed content disclosures (e.g.
  // Recent Reading Sessions, atomic Socratic prompts) for window.print(), then restore.
  useEffect(() => {
    const openedForPrint = new Set<HTMLDetailsElement>();
    const expandForPrint = () => {
      document
        .querySelectorAll<HTMLDetailsElement>('details[data-print-expand]:not([open])')
        .forEach(el => {
          openedForPrint.add(el);
          el.open = true;
        });
    };
    const restoreAfterPrint = () => {
      openedForPrint.forEach(el => {
        el.open = false;
      });
      openedForPrint.clear();
    };
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    const onMediaChange = (e: MediaQueryListEvent) => {
      if (e.matches) expandForPrint();
      else restoreAfterPrint();
    };
    if (mql?.matches) expandForPrint();

    window.addEventListener('beforeprint', expandForPrint);
    window.addEventListener('afterprint', restoreAfterPrint);
    mql?.addEventListener?.('change', onMediaChange);
    return () => {
      window.removeEventListener('beforeprint', expandForPrint);
      window.removeEventListener('afterprint', restoreAfterPrint);
      mql?.removeEventListener?.('change', onMediaChange);
    };
  }, []);

  return (
    <div className="relative h-screen h-[100dvh] print:h-auto pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] print:p-0 overflow-hidden print:overflow-visible bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground">
      <div className="relative z-10 flex flex-col flex-1 min-h-0 print:block print:overflow-visible">
        {children}
      </div>

      <Toaster
        visibleToasts={1}
        position="bottom-right"
        // CD D1.1: on phones, sit above the BottomNav and the home indicator.
        mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 76px)' }}
        className="toaster-wrapper"
        toastOptions={{
          className: 'notification-toast',
        }}
      />
    </div>
  );
}
