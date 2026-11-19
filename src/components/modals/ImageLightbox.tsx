import React, { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { useNativeDialog } from '../../hooks/useNativeDialog';
import { dialogClosedByValue, isTopmostOpenDialog } from '../../utils/dialogOverlay';
import { DriveImage } from '../common/DriveImage';

export interface ImageLightboxProps {
  attachment: Extract<Attachment, { type: 'image' }> | null;
  onClose: () => void;
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({ attachment, onClose }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const isOpen = Boolean(attachment);

  const focusInitial = useCallback(() => {
    if (closeBtnRef.current) {
      closeBtnRef.current.focus();
    } else {
      dialogRef.current?.focus();
    }
  }, []);

  useNativeDialog({
    dialogRef,
    isOpen,
    onClose,
    dismissOnBackdrop: true,
    focusInitial,
  });

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // CD D.2.2: Space closes the image too (Escape is handled natively via dialog `cancel`).
      if (e.key === ' ' && !e.repeat) {
        if (!isTopmostOpenDialog(dialogRef.current, document)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen]);

  if (!attachment) return null;

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={attachment.fileName || 'Image preview'}
      data-testid="image-lightbox"
      {...({ closedby: dialogClosedByValue(true) } as Record<string, string>)}
      className="pragya-dialog pragya-dialog--lightbox m-auto w-fit max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-4rem)] focus:outline-none"
    >
      <button
        ref={closeBtnRef}
        type="button"
        autoFocus
        aria-label="Close image lightbox"
        onClick={() => onCloseRef.current()}
        className="fixed top-[calc(env(safe-area-inset-top)+12px)] right-[max(env(safe-area-inset-right),1rem)] w-11 h-11 rounded-full bg-card border border-border text-foreground hover:bg-surface2 flex items-center justify-center shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="flex flex-col items-center justify-center">
        <div className="max-w-5xl max-h-[85dvh] flex items-center justify-center">
          <DriveImage
            attachment={attachment}
            alt={attachment.fileName}
            className="max-w-full max-h-[85dvh] rounded-[12px] border border-border object-contain shadow-2xl"
          />
        </div>

        <div className="mt-3 px-3 py-1.5 rounded-full bg-card border border-border text-label text-muted-foreground flex items-center gap-2 num">
          <span className="text-foreground font-medium truncate max-w-[260px] sm:max-w-md">
            {attachment.fileName}
          </span>
          {attachment.width && attachment.height && (
            <span>
              · {attachment.width}×{attachment.height}
            </span>
          )}
        </div>
      </div>
    </dialog>
  );
};
