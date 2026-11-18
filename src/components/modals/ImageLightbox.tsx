import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { DriveImage } from '../common/DriveImage';

export interface ImageLightboxProps {
  attachment: Extract<Attachment, { type: 'image' }> | null;
  onClose: () => void;
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({ attachment, onClose }) => {
  const lightboxRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const isOpen = Boolean(attachment);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;
    if (lightboxRef.current && !lightboxRef.current.contains(document.activeElement)) {
      lightboxRef.current.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // CD D.2.2: Space closes the image too (Esc stays the universal close).
      if (e.key === 'Escape' || (e.key === ' ' && !e.repeat)) {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== lightboxRef.current) {
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
      previouslyFocusedElementRef.current?.focus?.();
    };
  }, [isOpen]);

  if (!attachment) return null;

  return (
    <div
      ref={lightboxRef}
      role="dialog"
      aria-modal="true"
      aria-label={attachment.fileName || 'Image preview'}
      data-testid="image-lightbox"
      tabIndex={-1}
      onClick={e => {
        if (e.target === e.currentTarget) {
          onCloseRef.current();
        }
      }}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-4 sm:p-8 bg-background/90 backdrop-blur-md focus:outline-none"
    >
      <button
        type="button"
        aria-label="Close image lightbox"
        onClick={() => onCloseRef.current()}
        className="absolute top-[calc(env(safe-area-inset-top)+12px)] right-[max(env(safe-area-inset-right),1rem)] w-11 h-11 rounded-full bg-card border border-border text-foreground hover:bg-surface2 flex items-center justify-center shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X className="w-5 h-5" />
      </button>

      <div
        className="max-w-5xl max-h-[82vh] flex items-center justify-center"
        onClick={e => e.stopPropagation()}
      >
        <DriveImage
          attachment={attachment}
          alt={attachment.fileName}
          className="max-w-full max-h-[80vh] rounded-[12px] border border-border object-contain shadow-2xl"
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
  );
};
