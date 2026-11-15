import React from 'react';
import { Toaster } from 'sonner';

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-screen h-[100dvh] print:h-auto overflow-hidden print:overflow-visible bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground">
      <div className="relative z-10 flex flex-col flex-1 min-h-0 print:block print:overflow-visible">
        {children}
      </div>

      <Toaster
        visibleToasts={1}
        position="bottom-right"
        className="toaster-wrapper"
        toastOptions={{
          className: 'notification-toast',
        }}
      />
    </div>
  );
}
